import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api-client";
import type { VmInstance } from "@/lib/api-types";
import { project, vm, vpc } from "./vm-test-fixtures";
import { VmInstanceDetailPage } from "./vm-instance-detail-page";

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
  ProjectSelector: () => <span>プロジェクト選択</span>,
}));

function renderPage(item: VmInstance = vm) {
  vi.spyOn(api.vm.instances, "get").mockResolvedValue(item);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/vm/instances/vm-1"]}>
        <Routes>
          <Route path="/vm/instances" element={<div>仮想マシン一覧ルート</div>} />
          <Route path="/vm/instances/:vmId" element={<VmInstanceDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("VmInstanceDetailPage", () => {
  beforeEach(() => {
    vi.spyOn(api.projects, "list").mockResolvedValue({ items: [project] });
    vi.spyOn(api.vpc, "list").mockResolvedValue({ items: [vpc] });
  });

  it("接続情報・DNS名・ファイアウォールを表示する", async () => {
    renderPage();

    expect(await screen.findByText("ssh ubuntu@10.100.16.1")).toBeInTheDocument();
    expect(screen.getByText("web-01-e3eaef7a.vm.hetero.internal")).toBeInTheDocument();
    expect(screen.getByText("TCP 22 ← 10.0.128.0/24")).toBeInTheDocument();
    expect(screen.getByText("適用中")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "lab-net" })).toBeInTheDocument();
  });

  it("プロバイダーの状態が取れないときは警告し、保存済みの状態を表示する", async () => {
    renderPage({
      ...vm,
      status: { phase: "ready", ip_address: "10.100.16.9", observation: "unavailable" },
    });

    expect(await screen.findByText(/現在の状態を取得できません/)).toBeInTheDocument();
    expect(screen.getByText("ssh ubuntu@10.100.16.9")).toBeInTheDocument();
  });

  it("停止ボタンは他の仕様を保ったまま stopped だけを変えて更新する", async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(api.vm.instances, "update").mockResolvedValue({ ...vm, spec: { ...vm.spec, stopped: true } });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "停止" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const [organization, id, body] = update.mock.calls[0] ?? [];
    expect(organization).toBe("organization-1");
    expect(id).toBe("vm-1");
    expect(body?.name).toBe("web-01");
    expect(body?.spec).toEqual({ ...vm.spec, stopped: true });
  });

  it("削除は名前を入力して確認するまで実行できない", async () => {
    const user = userEvent.setup();
    const remove = vi.spyOn(api.vm.instances, "delete").mockResolvedValue({ ...vm, state: "deleting" });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "削除" }));
    const confirm = screen.getByRole("button", { name: "削除する" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "web-01");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(remove).toHaveBeenCalledWith("organization-1", "vm-1"));
    expect(await screen.findByText("仮想マシン一覧ルート")).toBeInTheDocument();
  });

  it("エラー状態ではプロバイダーのメッセージを表示する", async () => {
    renderPage({ ...vm, state: "error", status: { phase: "error", message: "capacity exhausted" } });
    expect(await screen.findByText("capacity exhausted")).toBeInTheDocument();
  });
});
