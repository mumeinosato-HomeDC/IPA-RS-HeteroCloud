import type {
  VmEgressMode,
  VmInstance,
  VmIngressRule,
  VmProtocol,
  VmProviderStatus,
  VmSpec,
} from "@/lib/api-types";

export const VM_REGION = "heteronet-global";
export const VM_IMAGES = [{ value: "ubuntu-26.04", label: "Ubuntu 26.04 LTS" }];
export const VM_LIMITS = {
  cpuCores: { min: 1, max: 16 },
  memoryMib: { min: 512, max: 131_072 },
  diskGib: { min: 8, max: 2_048 },
  sshKeys: 8,
  ingressRules: 32,
  sourceCidrs: 16,
  destinationCidrs: 32,
} as const;

/** The same private ranges the provider never lets egress reach. */
const PROTECTED_NETWORKS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/3",
];

export interface IngressFormRow {
  protocol: VmProtocol;
  ports: string;
  sources: string;
}

export interface VmFormValue {
  projectId: string;
  name: string;
  image: string;
  cpuCores: number;
  memoryMib: number;
  diskGib: number;
  username: string;
  sshKeys: string;
  vpcId: string;
  ingress: IngressFormRow[];
  egressMode: VmEgressMode;
  allowedDestinations: string;
  deniedDestinations: string;
  stopped: boolean;
}

export function defaultVmFormValue(): VmFormValue {
  return {
    projectId: "",
    name: "",
    image: VM_IMAGES[0].value,
    cpuCores: 2,
    memoryMib: 2048,
    diskGib: 20,
    username: "ubuntu",
    sshKeys: "",
    vpcId: "",
    ingress: [],
    egressMode: "internet",
    allowedDestinations: "",
    deniedDestinations: "",
    stopped: false,
  };
}

/** Splits free text on whitespace and commas. */
export function splitList(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

function ipv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

interface Cidr {
  start: number;
  end: number;
}

/** An IPv4 address or CIDR; a bare address is a /32. */
export function parseCidr(value: string): Cidr | null {
  const [address, prefixText, ...rest] = value.split("/");
  if (rest.length > 0 || address === undefined) return null;
  const base = ipv4(address);
  if (base === null) return null;
  let prefix = 32;
  if (prefixText !== undefined) {
    if (!/^\d{1,2}$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    if (prefix > 32) return null;
  }
  const size = 2 ** (32 - prefix);
  const start = Math.floor(base / size) * size;
  return { start, end: start + size - 1 };
}

export function cidrListError(
  label: string,
  values: string[],
  maximum: number,
): string | null {
  if (values.length > maximum) return `${label}は最大${maximum}件です。`;
  const bad = values.find((value) => parseCidr(value) === null);
  return bad ? `${label}に不正なIPv4アドレス/CIDRがあります: ${bad}` : null;
}

function overlapsProtected(cidr: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  return PROTECTED_NETWORKS.some((network) => {
    const range = parseCidr(network);
    return range !== null && parsed.start <= range.end && range.start <= parsed.end;
  });
}

export function portsError(ports: string): string | null {
  const [start, end = start, ...rest] = ports.split("-");
  if (rest.length > 0 || !/^\d{1,5}$/.test(start ?? "") || !/^\d{1,5}$/.test(end)) {
    return "ポートは 22 または 8000-8100 の形式で入力してください。";
  }
  const first = Number(start);
  const last = Number(end);
  return first >= 1 && last <= 65_535 && first <= last
    ? null
    : "ポートは 1〜65535 の範囲で、開始 ≤ 終了にしてください。";
}

export function sshKeyError(key: string): string | null {
  const [kind, blob] = key.trim().split(/\s+/);
  const kinds = [
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
  ];
  return kinds.includes(kind ?? "") && /^[A-Za-z0-9+/=]{16,4096}$/.test(blob ?? "")
    ? null
    : "OpenSSH形式の公開鍵（ssh-ed25519 AAAA… など）を入力してください。";
}

export function sshKeysFrom(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function usernameError(value: string): string | null {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(value) && value !== "root"
    ? null
    : "小文字英字で始まる32文字以内のユーザー名（root は不可）にしてください。";
}

export function vmFormError(value: VmFormValue, options: { minDiskGib?: number } = {}): string | null {
  const name = value.name.trim();
  if (!value.projectId) return "プロジェクトを選択してください。";
  if (name.length < 1 || name.length > 120) return "名前は1〜120文字で入力してください。";
  const { cpuCores, memoryMib, diskGib } = VM_LIMITS;
  if (!Number.isInteger(value.cpuCores) || value.cpuCores < cpuCores.min || value.cpuCores > cpuCores.max) {
    return `vCPUは${cpuCores.min}〜${cpuCores.max}で指定してください。`;
  }
  if (!Number.isInteger(value.memoryMib) || value.memoryMib < memoryMib.min || value.memoryMib > memoryMib.max) {
    return `メモリは${memoryMib.min}〜${memoryMib.max} MiBで指定してください。`;
  }
  const minDisk = Math.max(diskGib.min, options.minDiskGib ?? 0);
  if (!Number.isInteger(value.diskGib) || value.diskGib < minDisk || value.diskGib > diskGib.max) {
    return `ディスクは${minDisk}〜${diskGib.max} GiBで指定してください（縮小はできません）。`;
  }
  const userError = usernameError(value.username);
  if (userError) return userError;
  const keys = sshKeysFrom(value.sshKeys);
  if (keys.length < 1 || keys.length > VM_LIMITS.sshKeys) {
    return `SSH公開鍵を1〜${VM_LIMITS.sshKeys}件入力してください。`;
  }
  const keyError = keys.map(sshKeyError).find(Boolean);
  if (keyError) return keyError;
  if (value.ingress.length > VM_LIMITS.ingressRules) {
    return `受信ルールは最大${VM_LIMITS.ingressRules}件です。`;
  }
  for (const [index, rule] of value.ingress.entries()) {
    const label = `受信ルール${index + 1}`;
    if (rule.protocol !== "icmp") {
      const error = portsError(rule.ports.trim());
      if (error) return `${label}: ${error}`;
    }
    const sources = splitList(rule.sources);
    if (sources.length === 0) return `${label}: 送信元CIDRを入力してください。`;
    const error = cidrListError(`${label}の送信元`, sources, VM_LIMITS.sourceCidrs);
    if (error) return error;
  }
  const allowed = splitList(value.allowedDestinations);
  const denied = splitList(value.deniedDestinations);
  if (value.egressMode !== "restricted" && allowed.length > 0) {
    return "許可する宛先は、制限付きの送信モードでのみ指定できます。";
  }
  const allowedError = cidrListError("許可する宛先", allowed, VM_LIMITS.destinationCidrs);
  if (allowedError) return allowedError;
  const privateAllowed = allowed.find(overlapsProtected);
  if (privateAllowed) {
    return `許可する宛先 ${privateAllowed} はプライベート/インフラ向けのアドレスと重なっています。`;
  }
  return cidrListError("拒否する宛先", denied, VM_LIMITS.destinationCidrs);
}

export function vmSpecFromForm(value: VmFormValue, base?: VmSpec): VmSpec {
  const ingress: VmIngressRule[] = value.ingress.map((rule) => ({
    protocol: rule.protocol,
    ...(rule.protocol === "icmp" ? {} : { ports: rule.ports.trim() }),
    source_cidrs: splitList(rule.sources),
  }));
  return {
    region: VM_REGION,
    image: value.image,
    cpu_cores: value.cpuCores,
    memory_mib: value.memoryMib,
    disk_gib: value.diskGib,
    ssh_authorized_keys: sshKeysFrom(value.sshKeys),
    username: value.username,
    stopped: value.stopped,
    network: {
      vpc_id: value.vpcId || null,
      ingress,
      egress: {
        mode: value.egressMode,
        allowed_destination_cidrs: splitList(value.allowedDestinations),
        denied_destination_cidrs: splitList(value.deniedDestinations),
      },
    },
    metadata: base?.metadata ?? {},
  };
}

export function vmFormFromInstance(vm: VmInstance): VmFormValue {
  const { spec } = vm;
  return {
    projectId: vm.project_id,
    name: vm.name,
    image: spec.image,
    cpuCores: spec.cpu_cores,
    memoryMib: spec.memory_mib,
    diskGib: spec.disk_gib,
    username: spec.username,
    sshKeys: spec.ssh_authorized_keys.join("\n"),
    vpcId: spec.network.vpc_id ?? "",
    ingress: spec.network.ingress.map((rule) => ({
      protocol: rule.protocol,
      ports: rule.ports ?? "",
      sources: rule.source_cidrs.join(", "),
    })),
    egressMode: spec.network.egress.mode,
    allowedDestinations: spec.network.egress.allowed_destination_cidrs.join(", "),
    deniedDestinations: spec.network.egress.denied_destination_cidrs.join(", "),
    stopped: spec.stopped,
  };
}

/** The provider's view of the VM, whether it is the live one or the stored one. */
export function vmProviderStatus(vm: VmInstance): VmProviderStatus {
  return vm.status.status ?? vm.status;
}

export function formatMemory(mib: number): string {
  return mib >= 1024 && mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`;
}

export const EGRESS_LABELS: Record<VmEgressMode, string> = {
  internet: "インターネットへ（プライベート宛ては遮断）",
  restricted: "許可した宛先のみ",
  disabled: "送信なし（名前解決のみ）",
};

export function ingressSummary(rule: VmIngressRule): string {
  const target = rule.protocol === "icmp" ? "ICMP" : `${rule.protocol.toUpperCase()} ${rule.ports ?? ""}`;
  return `${target} ← ${rule.source_cidrs.join(", ")}`;
}
