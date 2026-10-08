//! Spec of a virtual machine provisioned by the Tadokoro (Proxmox VE) provider.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    pub metadata: BTreeMap<String, Value>,
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
