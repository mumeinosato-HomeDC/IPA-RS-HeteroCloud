import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api-client";
import { project, SSH_KEY, vm, vpc } from "./vm-test-fixtures";
import { VmInstancesPage } from "./vm-instances-page";

vi.mock("@/features/organizations/organization-context", () => ({
  useActiveOrganization: () => ({
    activeOrganization: {
      organization_id: "organization-1",
      organization_slug: "example",
      organization_name: "Example",
      principal_id: "principal-1",
      role: "owner",
    },
    memberships: [],
    setActiveOrganizationId: vi.fn(),
  }),
}));

vi.mock("@/components/shared/resource-selectors", () => ({
  ProjectSelector: ({ onValueChange }: { onValueChange: (value: string) => void }) => (
    <button type="button" onClick={() => onValueChange("project-1")}>
      テストプロジェクトを選択
    </button>
  ),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/vm/instances"]}>
        <Routes>
          <Route path="/vm/instances" element={<VmInstancesPage />} />
          <Route path="/vm/instances/:vmId" element={<div>仮想マシン詳細ルート</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("VmInstancesPage", () => {
  beforeEach(() => {
    vi.spyOn(api.vm.instances, "list").mockResolvedValue({ items: [vm] });
    vi.spyOn(api.projects, "list").mockResolvedValue({ items: [project] });
    vi.spyOn(api.vpc, "list").mockResolvedValue({ items: [vpc] });
  });

  it("一覧にIPアドレス・VPC・構成が表示され、行から詳細へ移動できる", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("web-01")).toBeInTheDocument();
    expect(screen.getByText("10.100.16.1")).toBeInTheDocument();
    expect(screen.getByText("lab-net")).toBeInTheDocument();
    expect(screen.getByText("2 vCPU / 2 GiB / 20 GiB")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "web-01の詳細を開く" }));
    expect(screen.getByText("仮想マシン詳細ルート")).toBeInTheDocument();
  });

  it("入力を検証して仮想マシンを作成し、詳細へ移動する", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api.vm.instances, "create").mockResolvedValue({ ...vm, id: "vm-2", name: "db-01" });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "仮想マシンを作成" }));
    // Nothing is created while the form is incomplete.
    expect(screen.getByRole("button", { name: "作成" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "名前" }), "db-01");
    await user.click(screen.getByRole("button", { name: "テストプロジェクトを選択" }));
    await user.click(screen.getByRole("textbox", { name: "SSH公開鍵" }));
    await user.paste(SSH_KEY);
    await user.click(screen.getByRole("button", { name: "受信ルールを追加" }));
    await user.type(screen.getByRole("textbox", { name: "送信元 (CIDR)" }), "10.0.128.0/24");
    await user.click(screen.getByRole("button", { name: "作成" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith("organization-1", {
        project_id: "project-1",
        name: "db-01",
        spec: {
          region: "heteronet-global",
          image: "ubuntu-26.04",
          cpu_cores: 2,
          memory_mib: 2048,
          disk_gib: 20,
          ssh_authorized_keys: [SSH_KEY],
          username: "ubuntu",
          stopped: false,
          network: {
            vpc_id: null,
            ingress: [{ protocol: "tcp", ports: "22", source_cidrs: ["10.0.128.0/24"] }],
            egress: { mode: "internet", allowed_destination_cidrs: [], denied_destination_cidrs: [] },
          },
          metadata: {},
        },
      }),
    );
    expect(await screen.findByText("仮想マシン詳細ルート")).toBeInTheDocument();
  });

  it("プライベート宛ての許可など不正な入力では作成できない", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api.vm.instances, "create").mockResolvedValue(vm);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "仮想マシンを作成" }));
    await user.type(screen.getByRole("textbox", { name: "名前" }), "bad");
    await user.click(screen.getByRole("button", { name: "テストプロジェクトを選択" }));
    await user.click(screen.getByRole("textbox", { name: "SSH公開鍵" }));
    await user.paste(SSH_KEY);
    await user.click(screen.getByRole("button", { name: "受信ルールを追加" }));
    await user.type(screen.getByRole("textbox", { name: "送信元 (CIDR)" }), "not-a-cidr");

    expect(screen.getByRole("button", { name: "作成" })).toBeDisabled();
    expect(await screen.findByText(/不正なIPv4アドレス/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});
