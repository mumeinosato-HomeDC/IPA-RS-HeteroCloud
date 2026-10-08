import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { type FormEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DataTable } from "@/components/shared/data-table";
import { ErrorState } from "@/components/shared/error-state";
import { FormError } from "@/components/shared/form-error";
import { PageHeader } from "@/components/shared/page-header";
import { PageLoading } from "@/components/shared/page-loading";
import { StatusBadge } from "@/components/shared/status-badge";
import { useActiveOrganization } from "@/features/organizations/organization-context";
import { api, getApiErrorMessage } from "@/lib/api-client";
import type { VmInstance } from "@/lib/api-types";
import { projectsQueryOptions, vmInstancesQueryOptions, vpcsQueryOptions } from "@/lib/queries";
import { formatDateTime, formatNumber } from "@/lib/utils";
import { VmForm } from "./vm-form";
import {
  defaultVmFormValue,
  formatMemory,
  type VmFormValue,
  vmFormError,
  vmProviderStatus,
  vmSpecFromForm,
} from "./vm-utils";

export function VmInstancesPage() {
  const { activeOrganization } = useActiveOrganization();
  const organizationId = activeOrganization.organization_id;
  const instances = useQuery(vmInstancesQueryOptions(organizationId));
  const projects = useQuery(projectsQueryOptions(organizationId));
  const vpcs = useQuery(vpcsQueryOptions(organizationId));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<VmFormValue>(defaultVmFormValue);

  const createVm = useMutation({
    mutationFn: (value: VmFormValue) =>
      api.vm.instances.create(organizationId, {
        project_id: value.projectId,
        name: value.name.trim(),
        spec: vmSpecFromForm(value),
      }),
    onSuccess: async (created) => {
      setCreateOpen(false);
      await queryClient.invalidateQueries({
        queryKey: ["organizations", organizationId, "vm", "instances"],
      });
      navigate(`/vm/instances/${created.id}`);
    },
  });
  const projectNames = useMemo(
    () => new Map((projects.data?.items ?? []).map((project) => [project.id, project.name])),
    [projects.data],
  );
  const vpcNames = useMemo(
    () => new Map((vpcs.data?.items ?? []).map((vpc) => [vpc.id, vpc.name])),
    [vpcs.data],
  );
  const columns = useMemo<ColumnDef<VmInstance, unknown>[]>(
    () => [
      {
        id: "name",
        accessorFn: (vm) => vm.name,
        header: "名前",
        cell: ({ row }) => (
          <SpaceBetween size="xxs">
            <Box fontWeight="bold">{row.original.name}</Box>
            <Box variant="code" className="mobile-hidden">
              {row.original.id}
            </Box>
          </SpaceBetween>
        ),
      },
      {
        id: "project",
        accessorFn: (vm) => projectNames.get(vm.project_id) ?? vm.project_id,
        header: "プロジェクト",
      },
      {
        accessorKey: "state",
        header: "状態",
        cell: ({ getValue }) => <StatusBadge status={getValue<VmInstance["state"]>()} />,
      },
      {
        id: "power",
        accessorFn: (vm) => vmProviderStatus(vm).power_state ?? "",
        header: "電源",
        cell: ({ row }) => {
          const power = vmProviderStatus(row.original).power_state;
          return power ? <StatusBadge status={power} /> : "-";
        },
      },
      {
        id: "address",
        accessorFn: (vm) => vmProviderStatus(vm).ip_address ?? "",
        header: "IPアドレス",
        cell: ({ row }) => {
          const address = vmProviderStatus(row.original).ip_address;
          return address ? <Box variant="code">{address}</Box> : "-";
        },
      },
      {
        id: "vpc",
        accessorFn: (vm) => {
          const id = vm.spec.network.vpc_id;
          return id ? (vpcNames.get(id) ?? id) : "";
        },
        header: "VPC",
        cell: ({ getValue }) => getValue<string>() || "-",
      },
      {
        id: "size",
        accessorFn: (vm) => vm.spec.cpu_cores,
        header: "構成",
        cell: ({ row }) =>
          `${row.original.spec.cpu_cores} vCPU / ${formatMemory(row.original.spec.memory_mib)} / ${row.original.spec.disk_gib} GiB`,
      },
      {
        accessorKey: "updated_at",
        header: "更新日時",
        cell: ({ getValue }) => formatDateTime(getValue<string>()),
      },
    ],
    [projectNames, vpcNames],
  );

  if (instances.isPending || projects.isPending) {
    return <PageLoading label="仮想マシンを読み込んでいます" />;
  }
  if (instances.isError || projects.isError) {
    return (
      <ErrorState
        title="仮想マシンを取得できませんでした"
        description={getApiErrorMessage(instances.error ?? projects.error)}
        onRetry={() => {
          void instances.refetch();
          void projects.refetch();
        }}
      />
    );
  }

  const items = instances.data.items;
  const running = items.filter((vm) => vmProviderStatus(vm).power_state === "running").length;
  const totalCpu = items.reduce((sum, vm) => sum + vm.spec.cpu_cores, 0);
  const totalMemory = items.reduce((sum, vm) => sum + vm.spec.memory_mib, 0);
  const validationError = vmFormError(form);

  const openCreator = () => {
    setForm({ ...defaultVmFormValue(), projectId: projects.data.items[0]?.id ?? "" });
    createVm.reset();
    setCreateOpen(true);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validationError) createVm.mutate(form);
  };

  return (
    <SpaceBetween size="l">
      <PageHeader
        title="仮想マシン"
        description={`${activeOrganization.organization_name} の仮想マシン（Proxmox VE）を管理します。`}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="icon"
              iconName="refresh"
              ariaLabel="仮想マシンを更新"
              onClick={() =>
                void queryClient.invalidateQueries({
                  queryKey: ["organizations", organizationId, "vm"],
                })
              }
            />
            <Button variant="primary" iconName="add-plus" onClick={openCreator}>
              仮想マシンを作成
            </Button>
          </SpaceBetween>
        }
      />
      <Container>
        <ColumnLayout columns={4} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">仮想マシン</Box>
            <Box variant="awsui-value-large">{formatNumber(items.length)}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">稼働中</Box>
            <Box variant="awsui-value-large">{formatNumber(running)}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">vCPU 合計</Box>
            <Box variant="awsui-value-large">{formatNumber(totalCpu)}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">メモリ合計</Box>
            <Box variant="awsui-value-large">{formatMemory(totalMemory)}</Box>
          </div>
        </ColumnLayout>
      </Container>
      <DataTable
        columns={columns}
        data={items}
        getRowId={(vm) => vm.id}
        onRowClick={(vm) => navigate(`/vm/instances/${vm.id}`)}
        getRowAriaLabel={(vm) => `${vm.name}の詳細を開く`}
        mobileVisibleColumns={["name", "state", "address"]}
        searchPlaceholder="名前、プロジェクト、IPアドレス、状態で検索"
        emptyTitle="仮想マシンがありません"
        emptyDescription="仮想マシンを作成すると、SSHで接続できるサーバーが数分で起動します。"
      />
      <Modal
        visible={createOpen}
        onDismiss={() => setCreateOpen(false)}
        size="large"
        header="仮想マシンを作成"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setCreateOpen(false)}>キャンセル</Button>
              <Button
                variant="primary"
                loading={createVm.isPending}
                disabled={Boolean(validationError)}
                onClick={() => createVm.mutate(form)}
              >
                作成
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <VmForm value={form} onChange={setForm} onSubmit={submit} disabled={createVm.isPending}>
          <FormError
            message={createVm.isError ? getApiErrorMessage(createVm.error) : validationError}
          />
        </VmForm>
      </Modal>
    </SpaceBetween>
  );
}
