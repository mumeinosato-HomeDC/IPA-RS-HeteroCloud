import { describe, expect, it } from "vitest";
import type { VmInstance } from "@/lib/api-types";
import {
  cidrListError,
  defaultVmFormValue,
  formatMemory,
  parseCidr,
  portsError,
  splitList,
  sshKeyError,
  vmFormError,
  vmFormFromInstance,
  vmProviderStatus,
  vmSpecFromForm,
  type VmFormValue,
} from "./vm-utils";

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAERHnScWeyI8R9LNgXVEJGjb/Cg8sopnWQJlfqkOv02 me@host";

function valid(): VmFormValue {
  return { ...defaultVmFormValue(), projectId: "project-1", name: "web", sshKeys: KEY };
}

describe("VM form helpers", () => {
  it("accepts the defaults once project, name and key are given", () => {
    expect(vmFormError(valid())).toBeNull();
  });

  it("builds the provider spec with the firewall policy", () => {
    const value: VmFormValue = {
      ...valid(),
      vpcId: "vpc-1",
      ingress: [
        { protocol: "tcp", ports: " 22 ", sources: "10.0.128.0/24, 192.0.2.7" },
        { protocol: "icmp", ports: "ignored", sources: "10.0.128.0/24" },
      ],
      egressMode: "restricted",
      allowedDestinations: "198.51.100.0/24",
      deniedDestinations: "198.51.100.128/25",
    };
    expect(vmFormError(value)).toBeNull();
    const spec = vmSpecFromForm(value);
    expect(spec.region).toBe("heteronet-global");
    expect(spec.network.vpc_id).toBe("vpc-1");
    expect(spec.network.ingress).toEqual([
      { protocol: "tcp", ports: "22", source_cidrs: ["10.0.128.0/24", "192.0.2.7"] },
      { protocol: "icmp", source_cidrs: ["10.0.128.0/24"] },
    ]);
    expect(spec.network.egress).toEqual({
      mode: "restricted",
      allowed_destination_cidrs: ["198.51.100.0/24"],
      denied_destination_cidrs: ["198.51.100.128/25"],
    });
    expect(spec.ssh_authorized_keys).toEqual([KEY]);
  });

  it("round-trips an instance through the form", () => {
    const value: VmFormValue = {
      ...valid(),
      vpcId: "vpc-1",
      ingress: [{ protocol: "udp", ports: "8000-8100", sources: "0.0.0.0/0" }],
      egressMode: "disabled",
    };
    const spec = vmSpecFromForm(value);
    const instance = { id: "vm-1", project_id: "project-1", name: "web", spec } as VmInstance;
    expect(vmSpecFromForm(vmFormFromInstance(instance), spec)).toEqual(spec);
  });

  it("rejects values the provider would refuse", () => {
    const cases: [Partial<VmFormValue>, RegExp][] = [
      [{ projectId: "" }, /プロジェクト/],
      [{ name: "  " }, /名前/],
      [{ cpuCores: 0 }, /vCPU/],
      [{ cpuCores: 17 }, /vCPU/],
      [{ memoryMib: 256 }, /メモリ/],
      [{ diskGib: 4 }, /ディスク/],
      [{ username: "root" }, /ユーザー名/],
      [{ sshKeys: "not a key" }, /公開鍵/],
      [{ sshKeys: "" }, /公開鍵/],
      [{ ingress: [{ protocol: "tcp", ports: "", sources: "10.0.0.0/8" }] }, /ポート/],
      [{ ingress: [{ protocol: "tcp", ports: "70000", sources: "10.0.0.0/8" }] }, /範囲/],
      [{ ingress: [{ protocol: "tcp", ports: "22", sources: "" }] }, /送信元/],
      [{ ingress: [{ protocol: "tcp", ports: "22", sources: "300.0.0.1" }] }, /不正/],
      [{ egressMode: "internet", allowedDestinations: "198.51.100.0/24" }, /制限付き/],
      [{ egressMode: "restricted", allowedDestinations: "10.100.0.0/16" }, /重なって/],
      [{ egressMode: "restricted", allowedDestinations: "8.0.0.0/5" }, /重なって/],
    ];
    for (const [patch, message] of cases) {
      expect(vmFormError({ ...valid(), ...patch }), JSON.stringify(patch)).toMatch(message);
    }
  });

  it("never allows shrinking the disk of an existing VM", () => {
    expect(vmFormError({ ...valid(), diskGib: 20 }, { minDiskGib: 30 })).toMatch(/縮小/);
    expect(vmFormError({ ...valid(), diskGib: 30 }, { minDiskGib: 30 })).toBeNull();
  });

  it("parses CIDRs and port ranges", () => {
    expect(parseCidr("10.0.0.0/8")).toEqual({ start: 167_772_160, end: 184_549_375 });
    expect(parseCidr("192.0.2.7")).toEqual({ start: 3_221_225_991, end: 3_221_225_991 });
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0")).toBeNull();
    expect(parseCidr("10.0.0.0/8/1")).toBeNull();
    expect(cidrListError("宛先", ["1.1.1.1", "x"], 4)).toMatch(/x/);
    expect(cidrListError("宛先", ["1.1.1.1", "2.2.2.2"], 1)).toMatch(/最大/);
    expect(portsError("22")).toBeNull();
    expect(portsError("8000-8100")).toBeNull();
    expect(portsError("9-1")).not.toBeNull();
    expect(portsError("1-2-3")).not.toBeNull();
    expect(splitList("a, b\nc  d")).toEqual(["a", "b", "c", "d"]);
    expect(sshKeyError(KEY)).toBeNull();
    expect(formatMemory(2048)).toBe("2 GiB");
    expect(formatMemory(1536)).toBe("1536 MiB");
  });

  it("reads live and stored provider status alike", () => {
    const live = { status: { status: { ip_address: "10.100.16.1" }, observation: "current" } } as VmInstance;
    const stored = { status: { ip_address: "10.100.16.2", phase: "ready" } } as VmInstance;
    expect(vmProviderStatus(live).ip_address).toBe("10.100.16.1");
    expect(vmProviderStatus(stored).ip_address).toBe("10.100.16.2");
  });
});
