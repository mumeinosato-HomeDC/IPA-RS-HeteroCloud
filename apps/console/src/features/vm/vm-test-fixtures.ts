import type { VmInstance } from "@/lib/api-types";

export const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAERHnScWeyI8R9LNgXVEJGjb/Cg8sopnWQJlfqkOv02 me@host";

export const project = {
  id: "project-1",
  organization_id: "organization-1",
  slug: "lab",
  name: "Lab",
  created_at: "2026-09-04T01:00:00Z",
};

export const vm: VmInstance = {
  id: "vm-1",
  organization_id: "organization-1",
  project_id: "project-1",
  provider: "vm",
  name: "web-01",
  generation: 3,
  state: "ready",
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
      vpc_id: "vpc-1",
      ingress: [{ protocol: "tcp", ports: "22", source_cidrs: ["10.0.128.0/24"] }],
      egress: { mode: "internet", allowed_destination_cidrs: [], denied_destination_cidrs: [] },
    },
    metadata: {},
  },
  status: {
    observation: "current",
    status: {
      phase: "ready",
      vmid: 101,
      node: "pve02",
      hostname: "web-01-e3eaef7a",
      ip_address: "10.100.16.1",
      power_state: "running",
      firewall: "enforced",
      dns_names: ["web-01-e3eaef7a.vm.hetero.internal"],
    },
  },
  created_at: "2026-09-04T01:00:00Z",
  updated_at: "2026-09-04T02:00:00Z",
};

export const vpc = {
  id: "vpc-1",
  organization_id: "organization-1",
  project_id: "project-1",
  provider: "vpc" as const,
  name: "lab-net",
  generation: 1,
  state: "ready" as const,
  spec: {
    region: "heteronet-global",
    description: "",
    nat: { enabled: false },
    security_groups: ["default"],
    rules: [],
    vm_access: true,
  },
  status: {},
  created_at: "2026-09-04T01:00:00Z",
  updated_at: "2026-09-04T02:00:00Z",
};
