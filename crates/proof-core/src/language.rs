use crate::{Proof, Result};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiLanguage {
    #[default]
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "en")]
    English,
}
impl Proof {
    pub fn ui_language(&self) -> Result<UiLanguage> {
        let value: Option<String> = self
            .store
            .connection
            .query_row(
                "SELECT value FROM settings WHERE key='ui_language'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or(Ok(UiLanguage::default()))
    }
    /// Stored independently so another window's reading preferences cannot
    /// overwrite the application language. No Git or Agent settings are touched.
    pub fn set_ui_language(&self, language: UiLanguage) -> Result<UiLanguage> {
        self.store.connection.execute("INSERT INTO settings(key,value) VALUES('ui_language',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(&language)?])?;
        Ok(language)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn language_survives_restart_and_reading_updates_but_resets_with_all_data() {
        let temp = tempfile::tempdir().unwrap();
        let proof = Proof::open(temp.path()).unwrap();
        assert_eq!(proof.ui_language().unwrap(), UiLanguage::Chinese);
        proof.set_ui_language(UiLanguage::English).unwrap();
        proof
            .set_preferences(crate::Preferences::default())
            .unwrap();
        drop(proof);
        let mut proof = Proof::open(temp.path()).unwrap();
        assert_eq!(proof.ui_language().unwrap(), UiLanguage::English);
        assert!(serde_json::from_str::<UiLanguage>("\"fr\"").is_err());
        let deletion = proof.prepare_data_deletion(crate::DataScope::All).unwrap();
        proof.delete_local_data(&deletion.id).unwrap();
        assert_eq!(proof.ui_language().unwrap(), UiLanguage::Chinese);
    }
}
