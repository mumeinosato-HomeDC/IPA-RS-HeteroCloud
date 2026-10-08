//! Spec of a virtual machine provisioned by the Tadokoro (Proxmox VE) provider.

use std::{collections::BTreeMap, net::Ipv4Addr};

use ipnet::Ipv4Net;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::DomainError;

pub const VM_REGION: &str = "heteronet-global";
pub const MAX_VM_CPU_CORES: u32 = 16;
pub const MIN_VM_MEMORY_MIB: u32 = 512;
pub const MAX_VM_MEMORY_MIB: u32 = 131_072;
pub const MIN_VM_DISK_GIB: u32 = 8;
pub const MAX_VM_DISK_GIB: u32 = 2_048;
pub const MAX_VM_SSH_KEYS: usize = 8;
pub const MAX_VM_METADATA_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmSpec {
    pub region: String,
    /// Provider-known image name, for example `ubuntu-26.04`.
    pub image: String,
    pub cpu_cores: u32,
    pub memory_mib: u32,
    pub disk_gib: u32,
    pub ssh_authorized_keys: Vec<String>,
    #[serde(default = "default_username")]
    pub username: String,
    #[serde(default)]
    pub stopped: bool,
    #[serde(default)]
    pub network: VmNetwork,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

pub const MAX_VM_INGRESS_RULES: usize = 32;
pub const MAX_VM_SOURCE_CIDRS: usize = 16;
pub const MAX_VM_DESTINATION_CIDRS: usize = 32;

/// Network policy of a VM. Every VM sits behind a default-deny firewall.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmNetwork {
    /// VMs of the same VPC may reach each other in both directions.
    #[serde(default)]
    pub vpc_id: Option<Uuid>,
    #[serde(default)]
    pub ingress: Vec<VmIngressRule>,
    #[serde(default)]
    pub egress: VmEgress,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VmProtocol {
    Tcp,
    Udp,
    Icmp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmIngressRule {
    pub protocol: VmProtocol,
    /// `22` or `8000-8100`; required for tcp/udp, not allowed for icmp.
    #[serde(default)]
    pub ports: Option<String>,
    pub source_cidrs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VmEgressMode {
    Disabled,
    Restricted,
    #[default]
    Internet,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmEgress {
    #[serde(default)]
    pub mode: VmEgressMode,
    #[serde(default)]
    pub allowed_destination_cidrs: Vec<String>,
    #[serde(default)]
    pub denied_destination_cidrs: Vec<String>,
}

/// Private and infrastructure ranges that egress never reaches directly.
const PROTECTED_NETWORKS: [&str; 8] = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "224.0.0.0/3",
];

fn parse_cidr(value: &str) -> Option<Ipv4Net> {
    if value.is_empty() || value.trim() != value {
        return None;
    }
    value
        .parse::<Ipv4Net>()
        .ok()
        .or_else(|| value.parse::<Ipv4Addr>().ok().map(Ipv4Net::from))
}

fn parse_cidrs(
    field: &str,
    values: &[String],
    maximum: usize,
) -> Result<Vec<Ipv4Net>, DomainError> {
    if values.len() > maximum {
        return Err(invalid_vm_spec(format!(
            "{field} must contain at most {maximum} entries"
        )));
    }
    values
        .iter()
        .map(|v| {
            parse_cidr(v).ok_or_else(|| {
                invalid_vm_spec(format!("{field} entries must be IPv4 addresses or CIDRs"))
            })
        })
        .collect()
}

fn valid_ports(value: &str) -> bool {
    let (start, end) = value.split_once('-').unwrap_or((value, value));
    matches!((start.parse::<u16>(), end.parse::<u16>()), (Ok(a), Ok(b)) if a >= 1 && a <= b)
}

impl VmNetwork {
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.ingress.len() > MAX_VM_INGRESS_RULES {
            return Err(invalid_vm_spec(format!(
                "at most {MAX_VM_INGRESS_RULES} ingress rules are allowed"
            )));
        }
        for rule in &self.ingress {
            match (rule.protocol, &rule.ports) {
                (VmProtocol::Icmp, None) => {}
                (VmProtocol::Icmp, Some(_)) => {
                    return Err(invalid_vm_spec("icmp ingress rules cannot have ports"));
                }
                (_, None) => {
                    return Err(invalid_vm_spec("tcp and udp ingress rules require ports"));
                }
                (_, Some(ports)) if valid_ports(ports) => {}
                (_, Some(_)) => {
                    return Err(invalid_vm_spec(
                        "ports must be a port or a range such as 8000-8100",
                    ));
                }
            }
            if rule.source_cidrs.is_empty() {
                return Err(invalid_vm_spec(
                    "ingress rules require at least one source CIDR",
                ));
            }
            parse_cidrs("source_cidrs", &rule.source_cidrs, MAX_VM_SOURCE_CIDRS)?;
        }
        let egress = &self.egress;
        let allowed = parse_cidrs(
            "allowed_destination_cidrs",
            &egress.allowed_destination_cidrs,
            MAX_VM_DESTINATION_CIDRS,
        )?;
        parse_cidrs(
            "denied_destination_cidrs",
            &egress.denied_destination_cidrs,
            MAX_VM_DESTINATION_CIDRS,
        )?;
        if egress.mode != VmEgressMode::Restricted && !allowed.is_empty() {
            return Err(invalid_vm_spec(
                "allowed_destination_cidrs requires restricted egress mode",
            ));
        }
        for network in &allowed {
            let overlaps = PROTECTED_NETWORKS
                .iter()
                .filter_map(|p| p.parse::<Ipv4Net>().ok())
                .any(|p| p.contains(network) || network.contains(&p));
            if overlaps {
                return Err(invalid_vm_spec(format!(
                    "allowed destination {network} overlaps a protected private or infrastructure network"
                )));
            }
        }
        Ok(())
    }
}

fn default_username() -> String {
    "ubuntu".into()
}

impl VmSpec {
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.region != VM_REGION {
            return Err(invalid_vm_spec(format!("region must be {VM_REGION}")));
        }
        validate_image(&self.image)?;
        if !(1..=MAX_VM_CPU_CORES).contains(&self.cpu_cores) {
            return Err(invalid_vm_spec(format!(
                "cpu_cores must be between 1 and {MAX_VM_CPU_CORES}"
            )));
        }
        if !(MIN_VM_MEMORY_MIB..=MAX_VM_MEMORY_MIB).contains(&self.memory_mib) {
            return Err(invalid_vm_spec(format!(
                "memory_mib must be between {MIN_VM_MEMORY_MIB} and {MAX_VM_MEMORY_MIB}"
            )));
        }
        if !(MIN_VM_DISK_GIB..=MAX_VM_DISK_GIB).contains(&self.disk_gib) {
            return Err(invalid_vm_spec(format!(
                "disk_gib must be between {MIN_VM_DISK_GIB} and {MAX_VM_DISK_GIB}"
            )));
        }
        if self.ssh_authorized_keys.is_empty() || self.ssh_authorized_keys.len() > MAX_VM_SSH_KEYS {
            return Err(invalid_vm_spec(format!(
                "between 1 and {MAX_VM_SSH_KEYS} ssh_authorized_keys are required"
            )));
        }
        for key in &self.ssh_authorized_keys {
            validate_ssh_key(key)?;
        }
        validate_username(&self.username)?;
        self.network.validate()?;
        let metadata = serde_json::to_vec(&self.metadata)
            .map_err(|_| invalid_vm_spec("metadata must be valid JSON"))?;
        if metadata.len() > MAX_VM_METADATA_BYTES {
            return Err(invalid_vm_spec("metadata must not exceed 64 KiB"));
        }
        Ok(())
    }
}

fn validate_image(value: &str) -> Result<(), DomainError> {
    let ok = !value.is_empty()
        && value.len() <= 63
        && value.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(invalid_vm_spec(
            "image must be a lowercase image name such as ubuntu-26.04",
        ))
    }
}

fn validate_username(value: &str) -> Result<(), DomainError> {
    let mut chars = value.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c == '_');
    let rest_ok =
        chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'));
    if first_ok && rest_ok && value.len() <= 32 && value != "root" {
        Ok(())
    } else {
        Err(invalid_vm_spec(
            "username must be a lowercase Linux user name other than root",
        ))
    }
}

fn validate_ssh_key(value: &str) -> Result<(), DomainError> {
    const TYPES: [&str; 5] = [
        "ssh-ed25519",
        "ssh-rsa",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
    ];
    let mut parts = value.split_whitespace();
    let (Some(kind), Some(blob)) = (parts.next(), parts.next()) else {
        return Err(invalid_vm_spec(
            "ssh_authorized_keys entries must be OpenSSH public keys",
        ));
    };
    let blob_ok = (16..=4096).contains(&blob.len())
        && blob
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
    let clean = value.len() <= 8192 && !value.chars().any(char::is_control);
    if TYPES.contains(&kind) && blob_ok && clean {
        Ok(())
    } else {
        Err(invalid_vm_spec(
            "ssh_authorized_keys entries must be OpenSSH public keys",
        ))
    }
}

fn invalid_vm_spec(message: impl Into<String>) -> DomainError {
    DomainError::InvalidVmSpec(message.into())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAERHnScWeyI8R9LNgXVEJGjb/Cg8sopnWQJlfqkOv02 me@host";

    fn spec() -> Result<VmSpec, serde_json::Error> {
        serde_json::from_value(json!({
            "region": "heteronet-global", "image": "ubuntu-26.04", "cpu_cores": 2,
            "memory_mib": 2048, "disk_gib": 20, "ssh_authorized_keys": [KEY]
        }))
    }

    #[test]
    fn valid_spec_round_trips_with_defaults() -> Result<(), Box<dyn std::error::Error>> {
        let spec = spec()?;
        spec.validate()?;
        assert_eq!(spec.username, "ubuntu");
        assert!(!spec.stopped);
        let again: VmSpec = serde_json::from_value(serde_json::to_value(&spec)?)?;
        assert_eq!(again, spec);
        Ok(())
    }

    #[test]
    fn network_defaults_to_an_isolated_internet_client() -> Result<(), Box<dyn std::error::Error>> {
        let spec = spec()?;
        assert_eq!(spec.network, VmNetwork::default());
        assert_eq!(spec.network.egress.mode, VmEgressMode::Internet);
        assert!(spec.network.ingress.is_empty());
        assert!(spec.network.vpc_id.is_none());
        Ok(())
    }

    #[test]
    fn rejects_unsafe_network_policies() -> Result<(), Box<dyn std::error::Error>> {
        let ok = spec()?;
        let with = |network: serde_json::Value| -> Result<VmSpec, serde_json::Error> {
            let mut value = serde_json::to_value(&ok)?;
            value["network"] = network;
            serde_json::from_value(value)
        };
        for bad in [
            json!({"ingress": [{"protocol": "tcp", "source_cidrs": ["10.0.0.0/8"]}]}),
            json!({"ingress": [{"protocol": "icmp", "ports": "22", "source_cidrs": ["10.0.0.0/8"]}]}),
            json!({"ingress": [{"protocol": "udp", "ports": "9-1", "source_cidrs": ["10.0.0.0/8"]}]}),
            json!({"ingress": [{"protocol": "tcp", "ports": "22", "source_cidrs": []}]}),
            json!({"ingress": [{"protocol": "tcp", "ports": "22", "source_cidrs": ["bad"]}]}),
            json!({"egress": {"mode": "internet", "allowed_destination_cidrs": ["198.51.100.0/24"]}}),
            json!({"egress": {"mode": "restricted", "allowed_destination_cidrs": ["10.100.0.0/16"]}}),
            json!({"egress": {"mode": "restricted", "allowed_destination_cidrs": ["8.0.0.0/5"]}}),
        ] {
            assert!(with(bad.clone())?.validate().is_err(), "{bad}");
        }
        assert!(with(json!({"unknown": 1})).is_err());
        let good = with(json!({
            "vpc_id": "018f0000-0000-7000-8000-000000000001",
            "ingress": [{"protocol": "tcp", "ports": "8000-8100", "source_cidrs": ["10.0.128.0/24", "192.0.2.7"]}],
            "egress": {"mode": "restricted", "allowed_destination_cidrs": ["198.51.100.0/24"], "denied_destination_cidrs": ["198.51.100.128/25"]}
        }))?;
        good.validate()?;
        Ok(())
    }

    #[test]
    fn rejects_out_of_range_and_unsafe_values() -> Result<(), Box<dyn std::error::Error>> {
        let ok = spec()?;
        for broken in [
            VmSpec {
                region: "elsewhere".into(),
                ..ok.clone()
            },
            VmSpec {
                image: "Ubuntu 26".into(),
                ..ok.clone()
            },
            VmSpec {
                cpu_cores: 0,
                ..ok.clone()
            },
            VmSpec {
                cpu_cores: 17,
                ..ok.clone()
            },
            VmSpec {
                memory_mib: 256,
                ..ok.clone()
            },
            VmSpec {
                disk_gib: 1,
                ..ok.clone()
            },
            VmSpec {
                ssh_authorized_keys: vec![],
                ..ok.clone()
            },
            VmSpec {
                ssh_authorized_keys: vec!["nope".into()],
                ..ok.clone()
            },
            VmSpec {
                ssh_authorized_keys: vec![format!("{KEY}\nssh-rsa AAAA")],
                ..ok.clone()
            },
            VmSpec {
                username: "root".into(),
                ..ok.clone()
            },
            VmSpec {
                username: "Bad User".into(),
                ..ok.clone()
            },
        ] {
            assert!(broken.validate().is_err(), "{broken:?}");
        }
        assert!(serde_json::from_value::<VmSpec>(json!({"region": "r", "gpu": true})).is_err());
        Ok(())
    }
}
