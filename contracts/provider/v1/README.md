# Provider API v1

HeteroCloud calls independently deployed service providers through a private
Kubernetes endpoint. Provider API v1 supports `flow`, `flash` and `vm` service
instances. Service-instance outbox events are routed by their immutable
provider field.

| Provider | Required JWT audience | Worker endpoint setting |
| --- | --- | --- |
| `flow` | `heterocloud-flow` | `HETEROCLOUD_FLOW_ENDPOINT` |
| `flash` | `heterocloud-flash` | `HETEROCLOUD_FLASH_ENDPOINT` |
| `vm` | `heterocloud-vm` | `HETEROCLOUD_VM_ENDPOINT` (optional) |

Every request carries `Authorization: Bearer <JWT>`. The JWT is signed by the
HeteroCloud provider key and contains:

```json
{
  "iss": "heterocloud",
  "aud": "heterocloud-flash",
  "sub": "principal UUID",
  "organization_id": "organization UUID",
  "project_id": "project UUID",
  "service_instance_id": "instance UUID",
  "action": "service-instance.reconcile",
  "generation": 1,
  "jti": "request UUID",
  "iat": 1785480000,
  "nbf": 1785480000,
  "exp": 1785480060
}
```

Providers must validate the signature, exact issuer and audience, action,
expiry, and monotonic generation. They must scope every database operation by
both `organization_id` and `project_id`. Repeated `jti` values are idempotent.
An otherwise valid token for one provider must not be accepted by another
provider because the audiences are distinct.

## Flash management API

The public HeteroCloud API exposes Flash instances through these
organization-scoped routes:

| Method | Route | IAM action | IAM resource |
| --- | --- | --- | --- |
| `GET` | `/api/v1/organizations/{organization_id}/flash/services` | `flash:ListInstances` | `hc:org:{organization_id}:flash/*` |
| `POST` | `/api/v1/organizations/{organization_id}/flash/services` | `flash:CreateInstance` | `hc:org:{organization_id}:flash/*` |
| `GET` | `/api/v1/organizations/{organization_id}/flash/services/{id}` | `flash:GetInstance` | `hc:org:{organization_id}:flash/instance/{id}` |
| `PUT` | `/api/v1/organizations/{organization_id}/flash/services/{id}` | `flash:UpdateInstance` | `hc:org:{organization_id}:flash/instance/{id}` |
| `DELETE` | `/api/v1/organizations/{organization_id}/flash/services/{id}` | `flash:DeleteInstance` | `hc:org:{organization_id}:flash/instance/{id}` |

Create accepts `project_id`, `name`, and `spec`. Update is a complete
replacement and accepts `name` and `spec`; omitted fields are not inherited.
The Flash spec is strict and rejects unknown fields:

```json
{
  "region": "heteronet-global",
  "image": "ghcr.io/example/game-server:v1",
  "replicas": 3,
  "cpu_millis": 500,
  "memory_mib": 512,
  "ports": [
    {
      "name": "game-udp",
      "protocol": "udp",
      "container_port": 7777,
      "service_port": 7777
    }
  ],
  "exposure": {
    "type": "public",
    "traffic_mode": "direct"
  },
  "env": {"LOG_LEVEL": "info"},
  "command": ["/app/server"],
  "args": ["--port=7777"],
  "metadata": {}
}
```

`protocol` is `tcp` or `udp`; exposure `type` is `internal` or `public`;
`traffic_mode` is `forwarded` or `direct`. Internal exposure always uses
`forwarded`. Hard validation limits are 1..100 replicas, 10..64000 CPU millis,
16..262144 MiB memory, 1..16 unique ports,
128 environment variables, 128 command elements, 256 argument elements, and
64 KiB of serialized metadata. Port names and protocol/service-port pairs are
unique. The provider owns enforcement of gVisor execution and exposure policy;
clients cannot select a runtime class through this contract.

## Reconcile

`PUT /internal/v1/service-instances/{service_instance_id}`

```json
{
  "generation": 1,
  "name": "production-realtime",
  "spec": {
    "region": "heteronet-global",
    "max_participants": 500,
    "max_rooms": 100,
    "rate_limit": {
      "requests_per_second": 20,
      "burst": 40
    },
    "metadata": {}
  }
}
```

For a `flash` instance, the same envelope carries the strict Flash spec from
the management API. HeteroCloud does not translate image, port, environment,
resource, or exposure fields before signing the provider request.

TURN is not a service mode. Flow always supplies STUN and short-lived TURN
credentials so normal ICE can prefer a direct path and use TURN automatically
when direct connectivity checks fail.

The provider returns `202 Accepted`, an operation identifier, and a required
provider status object. HeteroCloud records both and marks the instance ready
only if its generation still matches. Status updates never overwrite newer
desired state.

## Delete

`DELETE /internal/v1/service-instances/{service_instance_id}?generation=2`

Deletion is idempotent. Provider-owned rooms, queues, credentials, and usage
state are retained or removed according to the provider retention policy;
HeteroCloud owns only the management-plane instance record.

## VM management API (Tadokoro, Proxmox VE)

The `vm` provider is [HeteroCloud-Tadokoro](https://github.com/mumeinosato-HomeDC/HeteroCloud-Tadokoro).
It is optional: without `HETEROCLOUD_VM_ENDPOINT` the worker leaves `vm` events
queued with an "endpoint is not configured" error and VM status reads report the
provider as unavailable.

| Method | Route | IAM action | IAM resource |
| --- | --- | --- | --- |
| `GET` | `/api/v1/organizations/{organization_id}/vm/instances` | `vm:ListInstances` | `hc:org:{organization_id}:vm/*` |
| `POST` | `/api/v1/organizations/{organization_id}/vm/instances` | `vm:CreateInstance` | `hc:org:{organization_id}:vm/*` |
| `GET` | `/api/v1/organizations/{organization_id}/vm/instances/{id}` | `vm:GetInstance` | `hc:org:{organization_id}:vm/instance/{id}` |
| `PUT` | `/api/v1/organizations/{organization_id}/vm/instances/{id}` | `vm:UpdateInstance` | `hc:org:{organization_id}:vm/instance/{id}` |
| `DELETE` | `/api/v1/organizations/{organization_id}/vm/instances/{id}` | `vm:DeleteInstance` | `hc:org:{organization_id}:vm/instance/{id}` |

```json
{
  "region": "heteronet-global",
  "image": "ubuntu-26.04",
  "cpu_cores": 2,
  "memory_mib": 2048,
  "disk_gib": 20,
  "ssh_authorized_keys": ["ssh-ed25519 AAAA… me@host"],
  "username": "ubuntu",
  "stopped": false,
  "network": {
    "vpc_id": "018f…",
    "ingress": [{"protocol": "tcp", "ports": "22", "source_cidrs": ["10.0.128.0/24"]}],
    "egress": {"mode": "internet"}
  },
  "metadata": {}
}
```

`network` (all optional) controls the per-VM firewall. Every VM is default-deny:

* `vpc_id` – VMs with the same VPC reach each other in both directions. The VPC must
  exist in the same organization and project and have the VM's region; joining needs
  `vpc:AttachInstance` on `hc:org:{organization_id}:vpc/network/{vpc_id}`, and a VPC
  with VMs (or Flash services) in it cannot be deleted.
* `ingress[]` – `tcp`/`udp` (`ports`: `22` or `8000-8100`) or `icmp` from IPv4 CIDRs; default none.
* `egress.mode` – `internet` (default; private ranges stay blocked), `restricted`
  (only `allowed_destination_cidrs`, which may not overlap private ranges) or `disabled`;
  `denied_destination_cidrs` always wins. DNS to the platform resolver always works.

Limits: 1..16 cores, 512..131072 MiB memory, 8..2048 GiB disk, 1..8 SSH keys.
Unknown fields are rejected. Disks only grow and the image is fixed after creation;
the provider enforces both. `GET` merges the provider's live status (address, power
state) into `status`. The CLI is `heterocloud vm {create,get,list,update,delete}`.
