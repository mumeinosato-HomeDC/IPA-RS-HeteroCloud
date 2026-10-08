import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import RadioGroup from "@cloudscape-design/components/radio-group";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import { useQuery } from "@tanstack/react-query";
import type { FormEvent, ReactNode } from "react";
import { ProjectSelector } from "@/components/shared/resource-selectors";
import { useActiveOrganization } from "@/features/organizations/organization-context";
import type { VmEgressMode, VmProtocol } from "@/lib/api-types";
import { vpcsQueryOptions } from "@/lib/queries";
import {
  EGRESS_LABELS,
  type IngressFormRow,
  VM_IMAGES,
  VM_LIMITS,
  type VmFormValue,
  vmFormError,
} from "./vm-utils";

function integer(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

const PROTOCOLS: { value: VmProtocol; label: string }[] = [
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
  { value: "icmp", label: "ICMP" },
];

/**
 * Create or edit a VM. When editing, the project and image are fixed and the disk can only grow.
 */
export function VmForm({
  value,
  onChange,
  onSubmit,
  disabled,
  editing,
  minDiskGib,
  children,
}: {
  value: VmFormValue;
  onChange: (value: VmFormValue) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
  editing?: boolean;
  minDiskGib?: number;
  children?: ReactNode;
}) {
  const { activeOrganization } = useActiveOrganization();
  const vpcs = useQuery(vpcsQueryOptions(activeOrganization.organization_id));
  const update = <Key extends keyof VmFormValue>(key: Key, next: VmFormValue[Key]) =>
    onChange({ ...value, [key]: next });
  const updateRule = (index: number, patch: Partial<IngressFormRow>) =>
    update(
      "ingress",
      value.ingress.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    );
  const vpcOptions = [
    { value: "", label: "VPCに接続しない" },
    ...(vpcs.data?.items ?? [])
      .filter((vpc) => vpc.project_id === value.projectId)
      .map((vpc) => ({ value: vpc.id, label: vpc.name, description: vpc.id })),
  ];
  const validationError = vmFormError(value, { minDiskGib });

  return (
    <form onSubmit={onSubmit}>
      <SpaceBetween size="l">
        <ColumnLayout columns={2}>
          <FormField label="プロジェクト">
            <ProjectSelector
              value={value.projectId}
              onValueChange={(projectId) => onChange({ ...value, projectId, vpcId: "" })}
              disabled={disabled || editing}
            />
          </FormField>
          <FormField label="名前" description="DNS名の一部になります（英数字とハイフンに変換されます）。">
            <Input
              value={value.name}
              placeholder="web-01"
              autoComplete="off"
              disabled={disabled}
              onChange={({ detail }) => update("name", detail.value.slice(0, 120))}
            />
          </FormField>
        </ColumnLayout>
        <ColumnLayout columns={4}>
          <FormField label="イメージ">
            <Select
              selectedOption={VM_IMAGES.find((image) => image.value === value.image) ?? null}
              options={VM_IMAGES}
              disabled={disabled || editing}
              onChange={({ detail }) => update("image", detail.selectedOption.value ?? value.image)}
            />
          </FormField>
          <FormField
            label="vCPU"
            constraintText={`${VM_LIMITS.cpuCores.min}〜${VM_LIMITS.cpuCores.max}`}
          >
            <Input
              type="number"
              inputMode="numeric"
              value={String(value.cpuCores)}
              disabled={disabled}
              onChange={({ detail }) => update("cpuCores", integer(detail.value, value.cpuCores))}
            />
          </FormField>
          <FormField
            label="メモリ (MiB)"
            constraintText={`${VM_LIMITS.memoryMib.min}〜${VM_LIMITS.memoryMib.max}`}
          >
            <Input
              type="number"
              inputMode="numeric"
              step={256}
              value={String(value.memoryMib)}
              disabled={disabled}
              onChange={({ detail }) => update("memoryMib", integer(detail.value, value.memoryMib))}
            />
          </FormField>
          <FormField
            label="ディスク (GiB)"
            constraintText={editing ? `${minDiskGib ?? VM_LIMITS.diskGib.min}以上（拡張のみ）` : `${VM_LIMITS.diskGib.min}〜${VM_LIMITS.diskGib.max}`}
          >
            <Input
              type="number"
              inputMode="numeric"
              value={String(value.diskGib)}
              disabled={disabled}
              onChange={({ detail }) => update("diskGib", integer(detail.value, value.diskGib))}
            />
          </FormField>
        </ColumnLayout>
        <FormField
          label="ログインユーザー"
          description="cloud-initで作成され、公開鍵でSSHログインします（パスワードログインはありません）。"
        >
          <Input
            value={value.username}
            disabled={disabled}
            autoComplete="off"
            onChange={({ detail }) => update("username", detail.value)}
          />
        </FormField>
        <FormField
          label="SSH公開鍵"
          description={`1行に1つ、最大${VM_LIMITS.sshKeys}件。`}
        >
          <Textarea
            value={value.sshKeys}
            rows={3}
            placeholder="ssh-ed25519 AAAA… user@host"
            disabled={disabled}
            onChange={({ detail }) => update("sshKeys", detail.value)}
          />
        </FormField>

        <Container header={<Header variant="h3">ネットワークとファイアウォール</Header>}>
          <SpaceBetween size="l">
            <Box variant="small">
              VMは既定で受信・送信ともに遮断されています。必要な通信だけを許可してください。応答通信は自動で許可されます。
            </Box>
            <FormField
              label="VPC"
              description="同じVPCのVMとFlashサービスは互いに通信できます（VPCで「VMアクセス」を有効にした場合）。"
            >
              <Select
                selectedOption={vpcOptions.find((option) => option.value === value.vpcId) ?? vpcOptions[0] ?? null}
                options={vpcOptions}
                disabled={disabled || !value.projectId}
                onChange={({ detail }) => update("vpcId", detail.selectedOption.value ?? "")}
              />
            </FormField>
            <SpaceBetween size="s">
              <Header variant="h3">受信ルール</Header>
              {value.ingress.map((rule, index) => (
                <ColumnLayout columns={4} key={index}>
                  <FormField label="プロトコル">
                    <Select
                      selectedOption={PROTOCOLS.find((p) => p.value === rule.protocol) ?? null}
                      options={PROTOCOLS}
                      disabled={disabled}
                      onChange={({ detail }) =>
                        updateRule(index, { protocol: (detail.selectedOption.value ?? "tcp") as VmProtocol })
                      }
                    />
                  </FormField>
                  <FormField label="ポート" description={rule.protocol === "icmp" ? "ICMPでは不要" : "22 または 8000-8100"}>
                    <Input
                      value={rule.protocol === "icmp" ? "" : rule.ports}
                      disabled={disabled || rule.protocol === "icmp"}
                      onChange={({ detail }) => updateRule(index, { ports: detail.value })}
                    />
                  </FormField>
                  <FormField label="送信元 (CIDR)" description="カンマまたは空白区切り">
                    <Input
                      value={rule.sources}
                      placeholder="10.0.128.0/24"
                      disabled={disabled}
                      onChange={({ detail }) => updateRule(index, { sources: detail.value })}
                    />
                  </FormField>
                  <Box padding={{ top: "xl" }}>
                    <Button
                      formAction="none"
                      disabled={disabled}
                      onClick={() => update("ingress", value.ingress.filter((_, i) => i !== index))}
                    >
                      削除
                    </Button>
                  </Box>
                </ColumnLayout>
              ))}
              <Button
                formAction="none"
                iconName="add-plus"
                disabled={disabled || value.ingress.length >= VM_LIMITS.ingressRules}
                onClick={() =>
                  update("ingress", [...value.ingress, { protocol: "tcp", ports: "22", sources: "" }])
                }
              >
                受信ルールを追加
              </Button>
            </SpaceBetween>
            <FormField label="送信（外向き）">
              <RadioGroup
                value={value.egressMode}
                items={(Object.keys(EGRESS_LABELS) as VmEgressMode[]).map((mode) => ({
                  value: mode,
                  label: EGRESS_LABELS[mode],
                }))}
                onChange={({ detail }) => update("egressMode", detail.value as VmEgressMode)}
              />
            </FormField>
            {value.egressMode === "restricted" && (
              <FormField
                label="許可する宛先 (CIDR)"
                description="プライベート/インフラのアドレスとは重なれません。"
              >
                <Input
                  value={value.allowedDestinations}
                  placeholder="198.51.100.0/24"
                  disabled={disabled}
                  onChange={({ detail }) => update("allowedDestinations", detail.value)}
                />
              </FormField>
            )}
            {value.egressMode !== "disabled" && (
              <FormField label="拒否する宛先 (CIDR)" description="常に優先して遮断します（省略可）。">
                <Input
                  value={value.deniedDestinations}
                  disabled={disabled}
                  onChange={({ detail }) => update("deniedDestinations", detail.value)}
                />
              </FormField>
            )}
          </SpaceBetween>
        </Container>
        {children}
        <button type="submit" hidden disabled={Boolean(validationError)} />
      </SpaceBetween>
    </form>
  );
}
