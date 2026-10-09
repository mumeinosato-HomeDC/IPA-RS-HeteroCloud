import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, { type StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ErrorState } from "@/components/shared/error-state";
import { FormError } from "@/components/shared/form-error";
import { PageHeader } from "@/components/shared/page-header";
import { PageLoading } from "@/components/shared/page-loading";
import { RouterLink } from "@/components/shared/router-link";
import { StatusBadge } from "@/components/shared/status-badge";
import type { FlashShellConnectionState } from "@/features/flash/flash-web-shell";
import { useActiveOrganization } from "@/features/organizations/organization-context";
import { api, getApiErrorMessage } from "@/lib/api-client";
import { projectsQueryOptions, vmInstanceQueryOptions, vpcsQueryOptions } from "@/lib/queries";
import { formatDateTime } from "@/lib/utils";
import { VmForm } from "./vm-form";
import { VmVncConsole } from "./vm-vnc-console";
import {
  EGRESS_LABELS,
  formatMemory,
  ingressSummary,
  type VmFormValue,
  vmFormError,
  vmFormFromInstance,
  vmProviderStatus,
  vmSpecFromForm,
} from "./vm-utils";

const shellStatuses: Record<FlashShellConnectionState, { type: StatusIndicatorProps.Type; label: string }> = {
  connecting: { type: "loading", label: "接続中" },
  connected: { type: "success", label: "接続済み" },
  closed: { type: "stopped", label: "切断済み" },
  error: { type: "error", label: "接続エラー" },
};

export function VmInstanceDetailPage() {
  const { vmId = "" } = useParams<{ vmId: string }>();
  const { activeOrganization } = useActiveOrganization();
  const organizationId = activeOrganization.organization_id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const vm = useQuery({ ...vmInstanceQueryOptions(organizationId, vmId), enabled: Boolean(vmId) });
  const projects = useQuery(projectsQueryOptions(organizationId));
  const vpcs = useQuery(vpcsQueryOptions(organizationId));
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<VmFormValue | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shellSession, setShellSession] = useState(0);
  const [shellState, setShellState] = useState<FlashShellConnectionState>("closed");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["organizations", organizationId, "vm"] });
  };
  const save = useMutation({
    mutationFn: ({ value, stopped }: { value: VmFormValue; stopped?: boolean }) => {
      if (!vm.data) throw new Error("VM is not loaded");
      const spec = vmSpecFromForm(value, vm.data.spec);
      return api.vm.instances.update(organizationId, vmId, {
        name: value.name.trim(),
        spec: { ...spec, stopped: stopped ?? spec.stopped },
      });
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(vmInstanceQueryOptions(organizationId, vmId).queryKey, updated);
      setEditOpen(false);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.vm.instances.delete(organizationId, vmId),
    onSuccess: async () => {
      await refresh();
      navigate("/vm/instances", { replace: true });
    },
  });

  if (!vmId) {
    return <ErrorState title="仮想マシンを指定してください" description="仮想マシンIDがURLに含まれていません。" />;
  }
  if (vm.isPending || projects.isPending) {
    return <PageLoading label="仮想マシンの詳細を読み込んでいます" />;
  }
  if (vm.isError || projects.isError) {
    return (
      <ErrorState
        title="仮想マシンを取得できませんでした"
        description={getApiErrorMessage(vm.error ?? projects.error)}
        onRetry={() => {
          void vm.refetch();
          void projects.refetch();
        }}
      />
    );
  }

  const item = vm.data;
  const status = vmProviderStatus(item);
  const projectName = projects.data.items.find((p) => p.id === item.project_id)?.name ?? item.project_id;
  const vpcId = item.spec.network.vpc_id;
  const vpcName = vpcId ? (vpcs.data?.items.find((v) => v.id === vpcId)?.name ?? vpcId) : null;
  const busy = item.state === "deleting" || item.state === "provisioning" || item.state === "updating";
  const stopped = item.spec.stopped;
  const address = status.ip_address ?? null;
  const formError = form ? vmFormError(form, { minDiskGib: item.spec.disk_gib }) : null;
  const network = item.spec.network;
  const message = typeof status.message === "string" ? status.message : null;

  const openEditor = () => {
    setForm(vmFormFromInstance(item));
    save.reset();
    setEditOpen(true);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form && !formError) save.mutate({ value: form });
  };

  return (
    <SpaceBetween size="l">
      <RouterLink to="/vm/instances">仮想マシン</RouterLink>
      <PageHeader
        title={item.name}
        description={`仮想マシンID: ${item.id}`}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="icon"
              iconName="refresh"
              ariaLabel="仮想マシンを更新"
              onClick={() => void refresh()}
            />
            <Button
              iconName={stopped ? "caret-right-filled" : "close"}
              disabled={busy}
              loading={save.isPending && save.variables?.stopped !== undefined}
              onClick={() => save.mutate({ value: vmFormFromInstance(item), stopped: !stopped })}
            >
              {stopped ? "起動" : "停止"}
            </Button>
            <Button iconName="edit" disabled={busy} onClick={openEditor}>
              編集
            </Button>
            <Button
              iconName="remove"
              disabled={item.state === "deleting"}
              onClick={() => {
                setDeleteConfirmation("");
                remove.reset();
                setDeleteOpen(true);
              }}
            >
              削除
            </Button>
          </SpaceBetween>
        }
      />
      {item.status.observation === "unavailable" && (
        <Alert type="warning">プロバイダーから現在の状態を取得できません。表示は最後に保存された状態です。</Alert>
      )}
      {item.state === "error" && (
        <Alert type="error" header="仮想マシンの構成に失敗しました">
          {message ?? "プロバイダーがエラーを返しました。仕様を見直して更新してください。"}
        </Alert>
      )}
      {(item.state === "provisioning" || item.state === "updating") && (
        <Alert type="info">仮想マシンを構成しています。イメージの複製と起動には数分かかります。</Alert>
      )}
      {save.isError && !editOpen && <Alert type="error">{getApiErrorMessage(save.error)}</Alert>}

      <Container header={<Header variant="h2">概要</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          <KeyValuePairs
            items={[
              { label: "状態", value: <StatusBadge status={item.state} /> },
              {
                label: "電源",
                value: status.power_state ? <StatusBadge status={status.power_state} /> : "-",
              },
              { label: "プロジェクト", value: projectName },
              { label: "リージョン", value: item.spec.region },
            ]}
          />
          <KeyValuePairs
            items={[
              {
                label: "IPアドレス",
                value: address ? <Box variant="code">{address}</Box> : "未割り当て",
              },
              {
                label: "SSH接続",
                value: address ? (
                  <Box variant="code">{`ssh ${item.spec.username}@${address}`}</Box>
                ) : (
                  "-"
                ),
              },
              { label: "ホスト名", value: status.hostname ? <Box variant="code">{status.hostname}</Box> : "-" },
              {
                label: "DNS名",
                value:
                  status.dns_names && status.dns_names.length > 0 ? (
                    <SpaceBetween size="xxs">
                      {status.dns_names.map((name) => (
                        <Box variant="code" key={name}>
                          {name}
                        </Box>
                      ))}
                    </SpaceBetween>
                  ) : (
                    "-"
                  ),
              },
            ]}
          />
          <KeyValuePairs
            items={[
              { label: "vCPU", value: String(item.spec.cpu_cores) },
              { label: "メモリ", value: formatMemory(item.spec.memory_mib) },
              { label: "ディスク", value: `${item.spec.disk_gib} GiB` },
              { label: "イメージ", value: item.spec.image },
              { label: "ユーザー", value: item.spec.username },
              { label: "世代", value: String(item.generation) },
              { label: "作成日時", value: formatDateTime(item.created_at) },
              { label: "更新日時", value: formatDateTime(item.updated_at) },
            ]}
          />
        </ColumnLayout>
      </Container>

      <Container
        header={
          <Header
            variant="h2"
            description="PVEの画面コンソール(VNC)に接続します。ネットワーク設定に関わらず利用できます。"
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <StatusIndicator type={shellStatuses[shellState].type}>
                  {shellStatuses[shellState].label}
                </StatusIndicator>
                <Button
                  variant="primary"
                  iconName="script"
                  disabled={busy || stopped || status.power_state !== "running"}
                  onClick={() => {
                    setShellState("connecting");
                    setShellSession((session) => session + 1);
                  }}
                >
                  {shellSession > 0 ? "再接続" : "接続"}
                </Button>
                <Button
                  disabled={shellSession === 0}
                  onClick={() => {
                    setShellSession(0);
                    setShellState("closed");
                  }}
                >
                  切断
                </Button>
              </SpaceBetween>
            }
          >
            コンソール
          </Header>
        }
      >
        {shellSession > 0 ? (
          <VmVncConsole
            key={shellSession}
            url={api.vm.instances.consoleWebSocketUrl(organizationId, vmId)}
            onStateChange={setShellState}
          />
        ) : (
          <Box color="text-status-inactive">仮想マシンが起動中のときに接続できます。</Box>
        )}
      </Container>

      <Container header={<Header variant="h2">ネットワークとファイアウォール</Header>}>
        <SpaceBetween size="m">
          <KeyValuePairs
            columns={3}
            items={[
              {
                label: "VPC",
                value: vpcName ? <RouterLink to="/vpc/networks">{vpcName}</RouterLink> : "接続なし",
              },
              { label: "送信（外向き）", value: EGRESS_LABELS[network.egress.mode] },
              { label: "ファイアウォール", value: status.firewall === "enforced" ? "適用中" : "-" },
            ]}
          />
          <div>
            <Box variant="awsui-key-label">受信ルール</Box>
            {network.ingress.length === 0 ? (
              <Box color="text-status-inactive">許可している受信通信はありません。</Box>
            ) : (
              <SpaceBetween size="xxs">
                {network.ingress.map((rule, index) => (
                  <Box variant="code" key={index}>
                    {ingressSummary(rule)}
                  </Box>
                ))}
              </SpaceBetween>
            )}
          </div>
          {network.egress.mode === "restricted" && (
            <div>
              <Box variant="awsui-key-label">許可する宛先</Box>
              <Box variant="code">{network.egress.allowed_destination_cidrs.join(", ") || "-"}</Box>
            </div>
          )}
          {network.egress.denied_destination_cidrs.length > 0 && (
            <div>
              <Box variant="awsui-key-label">拒否する宛先</Box>
              <Box variant="code">{network.egress.denied_destination_cidrs.join(", ")}</Box>
            </div>
          )}
          {vpcId && (
            <Box variant="small">
              同じVPCの仮想マシンとは双方向に通信できます。FlashサービスへはVPCの「VMアクセス」が有効な場合に限り、そのサービスの仮想IPへ接続できます。
            </Box>
          )}
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">SSH公開鍵</Header>}>
        <SpaceBetween size="xxs">
          {item.spec.ssh_authorized_keys.map((key) => (
            <Box variant="code" key={key}>
              {key.length > 96 ? `${key.slice(0, 48)}…${key.slice(-32)}` : key}
            </Box>
          ))}
        </SpaceBetween>
      </Container>

      <Modal
        visible={editOpen}
        onDismiss={() => setEditOpen(false)}
        size="large"
        header="仮想マシンを編集"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setEditOpen(false)}>キャンセル</Button>
              <Button
                variant="primary"
                loading={save.isPending}
                disabled={!form || Boolean(formError)}
                onClick={() => form && save.mutate({ value: form })}
              >
                保存
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {form && (
          <VmForm
            value={form}
            onChange={setForm}
            onSubmit={submit}
            disabled={save.isPending}
            editing
            minDiskGib={item.spec.disk_gib}
          >
            <Alert type="info">
              vCPU・メモリ・SSH鍵・ユーザーの変更は、仮想マシンの再起動を伴います。ネットワークの変更は無停止で反映されます。
            </Alert>
            <FormError message={save.isError ? getApiErrorMessage(save.error) : formError} />
          </VmForm>
        )}
      </Modal>
      <Modal
        visible={deleteOpen}
        onDismiss={() => setDeleteOpen(false)}
        header="仮想マシンを削除"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setDeleteOpen(false)}>キャンセル</Button>
              <Button
                variant="primary"
                loading={remove.isPending}
                disabled={deleteConfirmation !== item.name}
                onClick={() => remove.mutate()}
              >
                削除する
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Alert type="warning">仮想マシンとそのディスクは完全に削除され、元に戻せません。</Alert>
          <FormField label={`確認のため「${item.name}」と入力してください`}>
            <Input
              value={deleteConfirmation}
              autoComplete="off"
              onChange={({ detail }) => setDeleteConfirmation(detail.value)}
            />
          </FormField>
          <FormError message={remove.isError ? getApiErrorMessage(remove.error) : null} />
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
