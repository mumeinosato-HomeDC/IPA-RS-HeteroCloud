use heterocloud_domain::OrganizationId;
use heterocloud_store::{BootstrapAdmin, Store};
use serde_json::{Value, json};
use uuid::Uuid;

const KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAERHnScWeyI8R9LNgXVEJGjb/Cg8sopnWQJlfqkOv02 me@host";

fn vm_spec(network: Value) -> Value {
    json!({
        "region": "heteronet-global", "image": "ubuntu-26.04", "cpu_cores": 1, "memory_mib": 1024,
        "disk_gib": 10, "ssh_authorized_keys": [KEY], "network": network
    })
}

#[tokio::test]
async fn vm_vpc_membership_is_validated_and_protects_the_vpc()
-> Result<(), Box<dyn std::error::Error>> {
    let Ok(dsn) = std::env::var("HETEROCLOUD_STORE_TEST_DATABASE_URL") else {
        return Ok(());
    };
    let store = Store::connect(&dsn, 6).await?;
    let database: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(store.pool())
        .await?;
    if !database.starts_with("heterocloud_test_") {
        return Err("requires a disposable heterocloud_test_ database".into());
    }
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        .execute(store.pool())
        .await?;
    store.migrate().await?;
    let owner = store
        .bootstrap_admin(BootstrapAdmin {
            email: "vm-owner@example.test",
            display_name: "VM owner",
            password_hash: "test-password-hash",
            organization_slug: "vm-test",
            organization_name: "VM test",
        })
        .await?;
    let member = owner.memberships.first().ok_or("missing membership")?;
    let (org, principal) = (member.organization_id, member.principal_id);
    let one = store.create_project(org, "vm-one", "VM one").await?;
    let two = store.create_project(org, "vm-two", "VM two").await?;

    let vpc = store
        .create_service_instance(
            org,
            one.id,
            principal,
            "vpc",
            "net",
            json!({"region": "heteronet-global"}),
        )
        .await?;
    let in_vpc = vm_spec(json!({"vpc_id": vpc.id.0}));

    // A VM without a VPC needs nothing.
    let standalone = store
        .create_service_instance(org, one.id, principal, "vm", "solo", vm_spec(json!({})))
        .await?;
    assert_eq!(standalone.spec["network"]["egress"]["mode"], "internet");

    // Same project and region: accepted.
    let member_vm = store
        .create_service_instance(org, one.id, principal, "vm", "a", in_vpc.clone())
        .await?;
    // Another project, another organization and unknown VPCs are refused.
    assert!(
        store
            .create_service_instance(org, two.id, principal, "vm", "x", in_vpc.clone())
            .await
            .is_err()
    );
    assert!(
        store
            .create_service_instance(
                OrganizationId(Uuid::now_v7()),
                one.id,
                principal,
                "vm",
                "x",
                in_vpc.clone()
            )
            .await
            .is_err()
    );
    assert!(
        store
            .create_service_instance(
                org,
                one.id,
                principal,
                "vm",
                "x",
                vm_spec(json!({"vpc_id": Uuid::now_v7()}))
            )
            .await
            .is_err()
    );
    // Invalid specs never reach the database.
    assert!(
        store
            .create_service_instance(
                org,
                one.id,
                principal,
                "vm",
                "x",
                vm_spec(json!({"ingress": [{"protocol": "tcp", "source_cidrs": ["10.0.0.0/8"]}]}))
            )
            .await
            .is_err()
    );
    // A VPC in a different region cannot host the VM.
    let other_region = store
        .create_service_instance(
            org,
            one.id,
            principal,
            "vpc",
            "other",
            json!({"region": "elsewhere"}),
        )
        .await?;
    assert!(
        store
            .create_service_instance(
                org,
                one.id,
                principal,
                "vm",
                "x",
                vm_spec(json!({"vpc_id": other_region.id.0}))
            )
            .await
            .is_err()
    );

    // Updates are validated the same way, and leaving the VPC frees it.
    let moved = vm_spec(json!({"vpc_id": other_region.id.0}));
    assert!(
        store
            .update_service_instance(org, member_vm.id, "vm", principal, "a", moved)
            .await
            .is_err()
    );
    // The VPC cannot be deleted while a VM is in it.
    assert!(
        store
            .begin_delete_service_instance(org, vpc.id, "vpc", principal)
            .await
            .is_err()
    );
    store
        .update_service_instance(org, member_vm.id, "vm", principal, "a", vm_spec(json!({})))
        .await?;
    store
        .begin_delete_service_instance(org, vpc.id, "vpc", principal)
        .await?;
    Ok(())
}
