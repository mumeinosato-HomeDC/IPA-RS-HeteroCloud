//! Live status lookups against the Tadokoro (Proxmox VE) VM provider.

use std::time::Duration;

use futures_util::{StreamExt, stream};
use heterocloud_domain::{PrincipalId, ServiceInstance, ServiceState};
use heterocloud_provider::{ProviderContext, ProviderSigner};
use serde_json::{Value, json};
use url::Url;

pub const VM_STATUS_ACTION: &str = "vm.status.get";
pub const VM_SHELL_ACTION: &str = "vm.shell";

pub struct VmProviderProxy {
    endpoint: Url,
    signer: ProviderSigner,
    client: reqwest::Client,
}

impl VmProviderProxy {
    pub fn new(endpoint: Url, signer: ProviderSigner, client: reqwest::Client) -> Self {
        Self {
            endpoint,
            signer,
            client,
        }
    }

    /// Opens the provider's serial-console relay for a running VM.
    pub async fn connect_shell(
        &self,
        principal: PrincipalId,
        instance: &ServiceInstance,
    ) -> Result<crate::flash_provider::ProviderWebSocket, Box<dyn std::error::Error + Send + Sync>>
    {
        use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};
        let token = self
            .signer
            .sign(ProviderContext {
                principal_id: principal,
                user_id: None,
                organization_id: instance.organization_id,
                project_id: instance.project_id,
                service_instance_id: instance.id,
                action: VM_SHELL_ACTION.into(),
                generation: instance.generation,
            })?
            .token;
        let mut url = self.endpoint.join(&format!(
            "internal/v1/service-instances/{}/shell",
            instance.id
        ))?;
        url.query_pairs_mut()
            .append_pair("generation", &instance.generation.to_string());
        let scheme = match url.scheme() {
            "http" => "ws",
            "https" => "wss",
            _ => return Err("VM provider endpoint must be http or https".into()),
        };
        url.set_scheme(scheme)
            .map_err(|()| "VM provider endpoint cannot carry a websocket")?;
        let mut request = url.as_str().into_client_request()?;
        request.headers_mut().insert(
            http::header::AUTHORIZATION,
            format!("Bearer {token}").parse()?,
        );
        let (socket, _) = connect_async(request).await?;
        Ok(socket)
    }

    async fn status(
        &self,
        principal: PrincipalId,
        instance: &ServiceInstance,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        let token = self
            .signer
            .sign(ProviderContext {
                principal_id: principal,
                user_id: None,
                organization_id: instance.organization_id,
                project_id: instance.project_id,
                service_instance_id: instance.id,
                action: VM_STATUS_ACTION.into(),
                generation: instance.generation,
            })?
            .token;
        let mut url = self
            .endpoint
            .join(&format!("internal/v1/service-instances/{}", instance.id))?;
        url.query_pairs_mut()
            .append_pair("generation", &instance.generation.to_string());
        let mut response = self
            .client
            .get(url)
            .bearer_auth(token)
            .timeout(Duration::from_secs(2))
            .send()
            .await?
            .error_for_status()?;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if body.len().saturating_add(chunk.len()) > 256 * 1024 {
                return Err("VM status too large".into());
            }
            body.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&body)?;
        if value["observed_generation"].as_i64() != Some(instance.generation) {
            return Err("VM status generation mismatch".into());
        }
        Ok(value)
    }
}

pub async fn refresh(
    provider: Option<&VmProviderProxy>,
    principal: PrincipalId,
    instance: ServiceInstance,
) -> ServiceInstance {
    refresh_many(provider, principal, vec![instance])
        .await
        .remove(0)
}

/// Attaches the provider's live status (power state, address, …) to each
/// instance; a slow or unreachable provider only marks the observation stale.
pub async fn refresh_many(
    provider: Option<&VmProviderProxy>,
    principal: PrincipalId,
    instances: Vec<ServiceInstance>,
) -> Vec<ServiceInstance> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    stream::iter(instances.into_iter().map(|mut instance| async move {
        let live = async {
            let provider = provider.ok_or("provider is not configured")?;
            provider
                .status(principal, &instance)
                .await
                .map_err(|_| "provider status unavailable")
        };
        match tokio::time::timeout_at(deadline, live).await {
            Ok(Ok(status)) => {
                if instance.state == ServiceState::Ready && status["phase"] != "ready" {
                    instance.state = ServiceState::Updating;
                }
                instance.status = json!({"status": status, "observation": "current"});
            }
            _ => {
                instance.status["observation"] = json!("unavailable");
            }
        }
        instance
    }))
    .buffered(4)
    .collect()
    .await
}
