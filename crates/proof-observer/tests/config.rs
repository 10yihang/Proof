use proof_observer::{config::*, protocol::Agent};
use serde_json::{json, Value};

fn spec(agent: Agent) -> HookSpec {
    let id = "353fb416-82c2-4b1b-8836-fb8b2b042e67";
    HookSpec {
        installation_id: id.into(),
        agent,
        agent_version: match agent {
            Agent::Codex => "0.153.4",
            Agent::Claude => "2.1.236",
        }
        .into(),
        helper_path: "/private/proof/helpers/revision-1/proof-observer".into(),
        registration_path: format!("/private/proof/installs/{id}/registration.json"),
    }
}
const EXISTING:&str="{\r\n  \"permissions\" : {\"deny\": [\"Bash(rm *)\"]},\r\n  \"model\": \"unchanged-model\",\r\n  \"hooks\": {\r\n    \"PreToolUse\": [ {\"matcher\":\"Bash\", \"hooks\":[{\"type\":\"command\",\"command\":\"existing-security-policy\"}]} ],\r\n    \"PostToolUse\": [ {\"matcher\":\"Write\", \"hooks\":[{\"type\":\"command\",\"command\":\"existing-formatter\"}]} ],\r\n    \"Stop\": []\r\n  },\r\n  \"escaped\": \"literal \\\"quote\\\", \\u4e2d\\u6587, [brace}]\"\r\n}\r\n";

#[test]
fn both_agents_keep_existing_hooks_permissions_and_original_format() {
    for agent in [Agent::Codex, Agent::Claude] {
        let spec = spec(agent);
        let plan = install_plan(Some(EXISTING.as_bytes()), &spec, None).unwrap();
        let after = plan.after.as_ref().unwrap();
        assert!(plan.changed);
        for literal in ["\"permissions\" : {\"deny\": [\"Bash(rm *)\"]}","{\"matcher\":\"Write\", \"hooks\":[{\"type\":\"command\",\"command\":\"existing-formatter\"}]}","\\u4e2d\\u6587"] {assert!(after.contains(literal));}
        let before: Value = serde_json::from_str(EXISTING).unwrap();
        let value: Value = serde_json::from_str(after).unwrap();
        assert_eq!(before["permissions"], value["permissions"]);
        assert_eq!(before["hooks"]["PreToolUse"], value["hooks"]["PreToolUse"]);
        assert_eq!(value["hooks"]["PostToolUse"].as_array().unwrap().len(), 2);
        for (event, groups) in value["hooks"].as_object().unwrap() {
            for group in groups.as_array().unwrap() {
                for handler in group["hooks"].as_array().unwrap() {
                    if handler["command"]
                        .as_str()
                        .unwrap()
                        .contains(&spec.installation_id)
                    {
                        assert!(!["PreToolUse", "PermissionRequest"].contains(&event.as_str()));
                        assert_eq!(
                            handler["async"],
                            !(agent == Agent::Codex
                                && ["Stop", "SessionEnd"].contains(&event.as_str()))
                        );
                        assert_eq!(handler["type"], "command");
                        assert_eq!(handler["timeout"], 1);
                        assert_eq!(handler.as_object().unwrap().len(), 4);
                    }
                }
            }
        }
        let repeat = install_plan(Some(after.as_bytes()), &spec, Some(&plan.ownership)).unwrap();
        assert!(!repeat.changed);
        assert_eq!(repeat.after.as_ref(), Some(after));
        let undo = uninstall_plan(Some(after.as_bytes()), &plan.ownership).unwrap();
        assert_eq!(undo.after.as_deref(), Some(EXISTING));
    }
}

#[test]
fn uninstall_only_removes_owned_handlers_after_user_additions() {
    let spec = spec(Agent::Claude);
    let plan = install_plan(Some(EXISTING.as_bytes()), &spec, None).unwrap();
    let mut edited: Value = serde_json::from_str(plan.after.as_ref().unwrap()).unwrap();
    edited["userLaterSetting"] = json!({"preserved":true});
    edited["hooks"]["Stop"][0]["hooks"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"command","command":"user-later-hook"}));
    edited["hooks"]["Stop"][0]["matcher"] = "user-selection".into();
    let before = serde_json::to_vec_pretty(&edited).unwrap();
    let undo = uninstall_plan(Some(&before), &plan.ownership).unwrap();
    let value: Value = serde_json::from_str(undo.after.as_ref().unwrap()).unwrap();
    assert_eq!(value["userLaterSetting"], edited["userLaterSetting"]);
    assert_eq!(value["hooks"]["Stop"][0]["matcher"], "user-selection");
    assert_eq!(
        value["hooks"]["Stop"][0]["hooks"],
        json!([{"type":"command","command":"user-later-hook"}])
    );
    assert!(!undo.after.unwrap().contains(&spec.installation_id));
}

#[test]
fn modified_owned_handler_is_a_conflict_for_install_and_uninstall() {
    let spec = spec(Agent::Codex);
    let plan = install_plan(None, &spec, None).unwrap();
    let mut edited: Value = serde_json::from_str(plan.after.as_ref().unwrap()).unwrap();
    let was_async = edited["hooks"]["Stop"][0]["hooks"][0]["async"]
        .as_bool()
        .unwrap();
    edited["hooks"]["Stop"][0]["hooks"][0]["async"] = (!was_async).into();
    let before = serde_json::to_vec(&edited).unwrap();
    assert!(
        matches!(install_plan(Some(&before),&spec,Some(&plan.ownership)),Err(error) if error.code=="OBSERVER_CONFIG_CONFLICT")
    );
    assert!(
        matches!(uninstall_plan(Some(&before),&plan.ownership),Err(error) if error.code=="OBSERVER_CONFIG_CONFLICT")
    );
}

#[test]
fn unknown_version_duplicate_keys_bad_json_and_size_limits_are_rejected() {
    let spec = spec(Agent::Codex);
    for input in [
        br#"{"hooks":{},"hooks":{}}"#.as_slice(),
        br#"{"permissions":{"deny":[],"deny":[]}}"#,
        b"{ not JSON }",
        b"[]",
        br#"{"hooks":[]}"#,
    ] {
        assert!(install_plan(Some(input), &spec, None).is_err());
    }
    let mut unknown = spec.clone();
    unknown.agent_version = "99.0.0".into();
    assert!(
        matches!(install_plan(None,&unknown,None),Err(error) if error.code=="OBSERVER_VERSION_UNSUPPORTED")
    );
    let input = serde_json::to_vec(&json!({"other":"x".repeat(1024*1024-100)})).unwrap();
    assert!(input.len() < 1024 * 1024);
    assert!(
        matches!(install_plan(Some(&input),&spec,None),Err(error) if error.code=="OBSERVER_CONFIG_LIMIT")
    );
}

#[test]
fn new_config_is_removed_only_when_no_user_content_remains() {
    let spec = spec(Agent::Claude);
    let plan = install_plan(None, &spec, None).unwrap();
    assert!(plan.ownership.created_file);
    assert!(
        uninstall_plan(plan.after.as_ref().map(|s| s.as_bytes()), &plan.ownership)
            .unwrap()
            .after
            .is_none()
    );
    let mut edited: Value = serde_json::from_str(plan.after.as_ref().unwrap()).unwrap();
    edited["model"] = "user-added".into();
    let undo =
        uninstall_plan(Some(&serde_json::to_vec(&edited).unwrap()), &plan.ownership).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(undo.after.as_ref().unwrap()).unwrap(),
        json!({"model":"user-added"})
    );
}

#[test]
fn helper_upgrade_replaces_owned_commands_without_duplicate_handlers() {
    let mut spec = spec(Agent::Codex);
    let original = install_plan(Some(EXISTING.as_bytes()), &spec, None).unwrap();
    spec.helper_path = "/private/proof/helpers/revision-2/proof-observer".into();
    let update = install_plan(
        original.after.as_ref().map(|s| s.as_bytes()),
        &spec,
        Some(&original.ownership),
    )
    .unwrap();
    let text = update.after.as_ref().unwrap();
    assert!(!text.contains("revision-1"));
    assert_eq!(text.matches("revision-2").count(), 8);
    let undo = uninstall_plan(Some(text.as_bytes()), &update.ownership).unwrap();
    assert_eq!(undo.after.as_deref(), Some(EXISTING));
}

#[test]
fn legacy_async_terminal_receipts_can_be_upgraded_and_uninstalled() {
    let spec = spec(Agent::Codex);
    let current = install_plan(Some(EXISTING.as_bytes()), &spec, None).unwrap();
    let mut legacy: Value = serde_json::from_str(current.after.as_ref().unwrap()).unwrap();
    for groups in legacy["hooks"].as_object_mut().unwrap().values_mut() {
        for group in groups.as_array_mut().unwrap() {
            for handler in group["hooks"].as_array_mut().unwrap() {
                if handler["command"]
                    .as_str()
                    .unwrap()
                    .contains(&spec.installation_id)
                {
                    handler["async"] = true.into();
                }
            }
        }
    }
    let mut receipt = current.ownership.clone();
    receipt.schema_version = 1;
    let bytes = serde_json::to_vec(&legacy).unwrap();
    let removed = uninstall_plan(Some(&bytes), &receipt).unwrap();
    assert!(!removed.after.unwrap().contains(&spec.installation_id));
    let upgraded = install_plan(Some(&bytes), &spec, Some(&receipt)).unwrap();
    assert_eq!(upgraded.ownership.schema_version, 2);
    let upgraded_json: Value = serde_json::from_str(upgraded.after.as_ref().unwrap()).unwrap();
    assert_eq!(
        upgraded_json["hooks"]["Stop"][0]["hooks"][0]["async"],
        false
    );
    assert_eq!(
        upgraded_json["hooks"]["SessionEnd"][0]["hooks"][0]["async"],
        false
    );
    assert!(!uninstall_plan(
        upgraded.after.as_deref().map(str::as_bytes),
        &upgraded.ownership
    )
    .unwrap()
    .after
    .unwrap()
    .contains(&spec.installation_id));
}

#[test]
fn moved_owned_hook_requires_explicit_reconciliation() {
    let spec = spec(Agent::Codex);
    let original = install_plan(None, &spec, None).unwrap();
    let mut value: Value = serde_json::from_str(original.after.as_ref().unwrap()).unwrap();
    let group = value["hooks"]
        .as_object_mut()
        .unwrap()
        .remove("Stop")
        .unwrap();
    value["hooks"]["Notification"] = group;
    assert!(
        matches!(install_plan(Some(&serde_json::to_vec(&value).unwrap()),&spec,Some(&original.ownership)),Err(error) if error.code=="OBSERVER_CONFIG_CONFLICT")
    );
}

#[test]
fn matcher_changes_duplicates_and_moved_events_are_checked_before_upgrade() {
    let old = spec(Agent::Codex);
    let plan = install_plan(None, &old, None).unwrap();
    let mut new = old.clone();
    new.helper_path = "/private/proof/helpers/new-version/proof-observer".into();
    let initial: Value = serde_json::from_str(plan.after.as_ref().unwrap()).unwrap();
    let mut matcher = initial.clone();
    matcher["hooks"]["PostToolUse"][0]["matcher"] = "Write".into();
    let mut duplicate = initial.clone();
    let entry = duplicate["hooks"]["PostToolUse"][0].clone();
    duplicate["hooks"]["PostToolUse"]
        .as_array_mut()
        .unwrap()
        .push(entry);
    let mut moved = initial;
    let entry = moved["hooks"]
        .as_object_mut()
        .unwrap()
        .remove("Stop")
        .unwrap();
    moved["hooks"]["Notification"] = entry;
    for value in [matcher, duplicate, moved] {
        let text = serde_json::to_vec(&value).unwrap();
        for next in [&old, &new] {
            assert!(
                matches!(install_plan(Some(&text),next,Some(&plan.ownership)),Err(error) if error.code=="OBSERVER_CONFIG_CONFLICT")
            );
        }
    }
}

#[test]
fn uninstall_checks_executable_references_even_when_hooks_are_absent() {
    let spec = spec(Agent::Claude);
    let plan = install_plan(None, &spec, None).unwrap();
    let before =
        serde_json::to_vec(&json!({"statusLine":{"type":"command","command":spec.command()}}))
            .unwrap();
    assert!(
        matches!(uninstall_plan(Some(&before),&plan.ownership),Err(error) if error.code=="OBSERVER_CONFIG_CONFLICT")
    );
}

#[test]
fn removal_uses_the_owned_schema_even_when_version_is_no_longer_an_install_candidate() {
    let spec = spec(Agent::Claude);
    let mut plan = install_plan(Some(EXISTING.as_bytes()), &spec, None).unwrap();
    plan.ownership.spec.agent_version = "no-longer-supported".into();
    let undo = uninstall_plan(plan.after.as_ref().map(|s| s.as_bytes()), &plan.ownership).unwrap();
    assert_eq!(undo.after.as_deref(), Some(EXISTING));
}

#[cfg(unix)]
#[test]
fn hook_command_quotes_paths_without_interpreting_shell_input() {
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("h' $(touch INJECTED); newline\n");
    fs::create_dir(&folder).unwrap();
    let helper = folder.join("helper");
    fs::write(&helper, b"#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    let mut spec = spec(Agent::Claude);
    spec.helper_path = helper.to_str().unwrap().into();
    spec.registration_path = folder
        .join(&spec.installation_id)
        .join("registration.json")
        .to_str()
        .unwrap()
        .into();
    spec.validate().unwrap();
    let output = Command::new("/bin/sh")
        .args(["-c", &spec.command()])
        .current_dir(temp.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("bridge\n--registration\n{}\n", spec.registration_path)
    );
    assert!(!temp.path().join("INJECTED").exists());
}
