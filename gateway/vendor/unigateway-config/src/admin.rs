use std::collections::{BTreeMap, HashSet};

use anyhow::Result;

use super::{
    ApiKeyEntry, AuthError, BindingEntry, GatewayApiKey, GatewayConfigFile, GatewayState, ModeView,
    ProviderEntry, ProviderModelOptions, ProviderView, ServiceEntry, ServiceModel,
    build_mode_views, default_round_robin,
};
use crate::routing::normalize_base_url;

fn non_empty_string(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn models_from_provider_entry(provider: &ProviderEntry) -> Vec<String> {
    let trimmed = provider.model_mapping.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') {
        return Vec::new();
    }
    if let Ok(map) = serde_json::from_str::<BTreeMap<String, String>>(trimmed) {
        map.keys()
            .map(|alias| alias.trim().to_string())
            .filter(|alias| !alias.is_empty())
            .collect()
    } else {
        Vec::new()
    }
}

impl GatewayState {
    pub async fn set_config_value(&self, key: &str, value: &str) -> Result<()> {
        let mut guard = self.write_config().await;
        match key {
            "preferences.default_mode" => {
                guard.file.preferences.default_mode = value.to_string();
            }
            _ => anyhow::bail!("unknown config key '{}'", key),
        }
        guard.dirty = true;
        Ok(())
    }

    pub async fn get_config_value(&self, key: &str) -> Result<String> {
        let guard = self.read_config().await;
        match key {
            "preferences.default_mode" => Ok(guard.file.preferences.default_mode.clone()),
            _ => anyhow::bail!("unknown config key '{}'", key),
        }
    }

    pub async fn list_services(&self) -> Vec<(String, String)> {
        let guard = self.read_config().await;
        guard
            .file
            .services
            .iter()
            .map(|s| (s.id.clone(), s.name.clone()))
            .collect()
    }

    pub async fn list_services_with_routing(&self) -> Vec<(String, String, String)> {
        let guard = self.read_config().await;
        guard
            .file
            .services
            .iter()
            .map(|service| {
                (
                    service.id.clone(),
                    service.name.clone(),
                    service.routing_strategy.clone(),
                )
            })
            .collect()
    }

    pub async fn config_snapshot(&self) -> GatewayConfigFile {
        self.read_config().await.file.clone()
    }

    pub async fn get_default_mode(&self) -> Option<String> {
        let guard = self.read_config().await;
        let default_mode = guard.file.preferences.default_mode.trim();
        if default_mode.is_empty() {
            None
        } else {
            Some(default_mode.to_string())
        }
    }

    pub async fn list_mode_views(&self) -> Vec<ModeView> {
        let guard = self.read_config().await;
        let default_mode = guard.file.preferences.default_mode.clone();
        build_mode_views(&guard.file, &default_mode)
    }

    pub async fn set_default_mode(&self, mode_id: &str) -> Result<()> {
        let mut guard = self.write_config().await;
        if !guard
            .file
            .services
            .iter()
            .any(|service| service.id == mode_id)
        {
            anyhow::bail!("mode '{}' not found", mode_id);
        }
        guard.file.preferences.default_mode = mode_id.to_string();
        guard.dirty = true;
        Ok(())
    }

    pub async fn create_service(&self, id: &str, name: &str) {
        {
            let mut guard = self.write_config().await;
            if let Some(s) = guard.file.services.iter_mut().find(|s| s.id == id) {
                s.name = name.to_string();
            } else {
                guard.file.services.push(ServiceEntry {
                    id: id.to_string(),
                    name: name.to_string(),
                    routing_strategy: default_round_robin(),
                });
            }
            guard.dirty = true;
        }
        self.request_core_sync().await;
    }

    pub async fn set_service_routing_strategy(
        &self,
        service_id: &str,
        routing_strategy: &str,
    ) -> Result<()> {
        {
            let mut guard = self.write_config().await;
            let Some(service) = guard
                .file
                .services
                .iter_mut()
                .find(|service| service.id == service_id)
            else {
                anyhow::bail!("service '{}' not found", service_id);
            };
            service.routing_strategy = routing_strategy.to_string();
            guard.dirty = true;
        }
        self.request_core_sync().await;
        Ok(())
    }

    pub async fn list_provider_views(&self) -> Vec<ProviderView> {
        let guard = self.read_config().await;
        guard
            .file
            .providers
            .iter()
            .enumerate()
            .map(|(i, p)| ProviderView {
                id: i as i64,
                name: p.name.clone(),
                provider_type: p.provider_type.clone(),
                endpoint_id: non_empty_string(&p.endpoint_id),
                base_url: non_empty_string(&p.base_url),
                default_model: non_empty_string(&p.default_model),
                models: models_from_provider_entry(p),
                is_enabled: p.is_enabled,
            })
            .collect()
    }

    /// Returns the structured model catalog for a service.
    ///
    /// Provider order follows binding priority (ascending). Aliases within a
    /// provider come from trimmed `model_mapping` keys (lexicographically sorted)
    /// followed by `default_model` if it is non-empty and not already present.
    pub async fn list_service_models(&self, service_id: &str) -> Vec<ServiceModel> {
        let providers = self.select_all_providers_for_service(service_id, "").await;
        let mut result = Vec::new();
        for provider in providers {
            let mut mapping = BTreeMap::new();

            if let Some(raw) = provider.model_mapping.as_deref() {
                let trimmed = raw.trim();
                if trimmed.starts_with('{')
                    && let Ok(parsed) = serde_json::from_str::<BTreeMap<String, String>>(trimmed)
                {
                    mapping = parsed
                        .into_iter()
                        .map(|(k, v)| (k.trim().to_string(), v))
                        .collect();
                }
            }

            let mut seen_aliases = HashSet::new();
            let mut aliases: Vec<String> = Vec::new();

            for key in mapping.keys() {
                let alias = key.trim();
                if !alias.is_empty() && seen_aliases.insert(alias.to_string()) {
                    aliases.push(alias.to_string());
                }
            }
            aliases.sort();

            if let Some(default) = provider.default_model.as_deref() {
                let default = default.trim();
                if !default.is_empty() && seen_aliases.insert(default.to_string()) {
                    aliases.push(default.to_string());
                }
            }

            for alias in aliases {
                let canonical = mapping.get(&alias).cloned();
                result.push(ServiceModel {
                    id: format!("{}/{}", provider.name, alias),
                    alias,
                    canonical,
                    owned_by: provider.name.clone(),
                });
            }
        }
        result
    }

    /// Returns a flat, expanded, deduplicated list of `(id, owned_by)` pairs
    /// suitable for emitting an OpenAI-compatible `/v1/models` response.
    ///
    /// Deduplication happens on the final expanded id set (composite + bare alias).
    /// The first occurrence is retained.
    pub async fn list_service_model_ids(&self, service_id: &str) -> Vec<(String, String)> {
        let models = self.list_service_models(service_id).await;
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for model in models {
            for id in model.routing_ids() {
                let id = id.to_string();
                if seen.insert(id.clone()) {
                    result.push((id, model.owned_by.clone()));
                }
            }
        }
        result
    }

    /// Validates that an API key exists and is active without consuming quota
    /// or acquiring runtime limits.
    pub async fn authorize_readonly(&self, raw_key: &str) -> Result<GatewayApiKey, AuthError> {
        let key = self
            .find_gateway_api_key(raw_key)
            .await
            .ok_or(AuthError::InvalidKey)?;
        if key.is_active != 1 {
            return Err(AuthError::InactiveKey);
        }
        Ok(key)
    }

    pub async fn update_provider_by_name(
        &self,
        name: &str,
        base_url: Option<&str>,
        api_key: Option<&str>,
        default_model: Option<&str>,
        model_mapping: Option<&str>,
        provider_type: Option<&str>,
    ) -> Result<()> {
        let mut guard = self.write_config().await;
        let provider = guard
            .file
            .providers
            .iter_mut()
            .find(|p| p.name == name)
            .ok_or_else(|| anyhow::anyhow!("provider '{}' not found", name))?;

        if let Some(url) = base_url {
            let endpoint_id = provider.endpoint_id.as_str();
            let mut final_base_url = normalize_base_url(url);
            if !endpoint_id.is_empty()
                && let Some((_, endpoint)) = llm_providers::get_endpoint(endpoint_id)
            {
                let default_url = normalize_base_url(endpoint.base_url);
                if final_base_url == default_url {
                    final_base_url = String::new();
                }
            }
            provider.base_url = final_base_url;
        }
        if let Some(key) = api_key {
            provider.api_key = key.to_string();
        }
        if let Some(model) = default_model {
            provider.default_model = model.to_string();
        }
        if let Some(mapping) = model_mapping {
            provider.model_mapping = mapping.to_string();
        }
        if let Some(pt) = provider_type {
            provider.provider_type = pt.to_string();
        }
        guard.dirty = true;
        drop(guard);
        self.request_core_sync().await;
        Ok(())
    }

    pub async fn delete_provider_by_name(&self, name: &str) -> Result<()> {
        let mut guard = self.write_config().await;
        let before = guard.file.providers.len();
        guard.file.providers.retain(|p| p.name != name);
        if guard.file.providers.len() == before {
            anyhow::bail!("provider '{}' not found", name);
        }
        guard.file.bindings.retain(|b| b.provider_name != name);
        guard.dirty = true;
        drop(guard);
        self.request_core_sync().await;
        Ok(())
    }

    pub async fn list_providers(
        &self,
    ) -> Vec<(i64, String, String, Option<String>, Option<String>)> {
        let guard = self.read_config().await;
        guard
            .file
            .providers
            .iter()
            .enumerate()
            .map(|(i, p)| {
                (
                    i as i64,
                    p.name.clone(),
                    p.provider_type.clone(),
                    if p.endpoint_id.is_empty() {
                        None
                    } else {
                        Some(p.endpoint_id.clone())
                    },
                    if p.base_url.is_empty() {
                        None
                    } else {
                        Some(p.base_url.clone())
                    },
                )
            })
            .collect()
    }

    pub async fn create_provider(
        &self,
        name: &str,
        provider_type: &str,
        endpoint_id: &str,
        base_url: Option<&str>,
        api_key: &str,
        model_mapping: Option<&str>,
    ) -> i64 {
        self.create_provider_with_models(
            name,
            provider_type,
            endpoint_id,
            base_url,
            api_key,
            ProviderModelOptions {
                default_model: None,
                model_mapping,
            },
        )
        .await
    }

    pub async fn create_provider_with_models(
        &self,
        name: &str,
        provider_type: &str,
        endpoint_id: &str,
        base_url: Option<&str>,
        api_key: &str,
        model_options: ProviderModelOptions<'_>,
    ) -> i64 {
        let idx = {
            let mut guard = self.write_config().await;

            // If base_url is provided but matches the default base_url for this endpoint_id,
            // we store it as empty to keep config.toml clean and rely on single source of truth.
            let mut final_base_url = base_url.map(normalize_base_url).unwrap_or_default();
            if !endpoint_id.is_empty()
                && let Some((_, endpoint)) = llm_providers::get_endpoint(endpoint_id)
            {
                let default_url = normalize_base_url(endpoint.base_url);
                if final_base_url == default_url {
                    final_base_url = String::new();
                }
            }

            let entry = ProviderEntry {
                name: name.to_string(),
                provider_type: provider_type.to_string(),
                endpoint_id: endpoint_id.to_string(),
                base_url: final_base_url,
                api_key: api_key.to_string(),
                default_model: model_options.default_model.unwrap_or("").to_string(),
                model_mapping: model_options.model_mapping.unwrap_or("").to_string(),
                is_enabled: true,
            };
            let idx = if let Some((i, p)) = guard
                .file
                .providers
                .iter_mut()
                .enumerate()
                .find(|(_, p)| p.name == name)
            {
                *p = entry;
                i as i64
            } else {
                let i = guard.file.providers.len() as i64;
                guard.file.providers.push(entry);
                i
            };
            guard.dirty = true;
            idx
        };
        self.request_core_sync().await;
        idx
    }

    pub async fn bind_provider_to_service(&self, service_id: &str, provider_id: i64) -> Result<()> {
        self.bind_provider_to_service_with_priority(service_id, provider_id, 0)
            .await
    }

    pub async fn bind_provider_to_service_with_priority(
        &self,
        service_id: &str,
        provider_id: i64,
        priority: i64,
    ) -> Result<()> {
        let provider_name = {
            let guard = self.read_config().await;
            let idx = provider_id as usize;
            guard.file.providers.get(idx).map(|p| p.name.clone())
        };
        let Some(provider_name) = provider_name else {
            anyhow::bail!("provider_id {} not found", provider_id);
        };
        {
            let mut guard = self.write_config().await;
            let exists = guard
                .file
                .bindings
                .iter()
                .any(|b| b.service_id == service_id && b.provider_name == provider_name);
            if let Some(binding) = guard.file.bindings.iter_mut().find(|binding| {
                binding.service_id == service_id && binding.provider_name == provider_name
            }) {
                binding.priority = priority;
                guard.dirty = true;
            } else if !exists {
                guard.file.bindings.push(BindingEntry {
                    service_id: service_id.to_string(),
                    provider_name,
                    priority,
                });
                guard.dirty = true;
            }
        }
        self.request_core_sync().await;
        Ok(())
    }

    pub async fn list_api_keys(&self) -> Vec<ApiKeyEntry> {
        let guard = self.read_config().await;
        guard.file.api_keys.clone()
    }

    pub async fn create_api_key(
        &self,
        key: &str,
        service_id: &str,
        quota_limit: Option<i64>,
        qps_limit: Option<f64>,
        concurrency_limit: Option<i64>,
    ) {
        let mut guard = self.write_config().await;
        let used = guard
            .file
            .api_keys
            .iter()
            .find(|a| a.key == key)
            .map(|a| a.used_quota)
            .unwrap_or(0);
        let entry = ApiKeyEntry {
            key: key.to_string(),
            service_id: service_id.to_string(),
            quota_limit,
            used_quota: used,
            is_active: true,
            qps_limit,
            concurrency_limit,
        };
        if let Some(a) = guard.file.api_keys.iter_mut().find(|a| a.key == key) {
            *a = entry;
        } else {
            guard.file.api_keys.push(entry);
        }
        guard.dirty = true;
    }

    pub async fn rebind_api_key_service(&self, key: &str, service_id: &str) -> Result<()> {
        let mut guard = self.write_config().await;
        if !guard
            .file
            .services
            .iter()
            .any(|service| service.id == service_id)
        {
            anyhow::bail!("service '{}' not found", service_id);
        }

        let Some(api_key) = guard
            .file
            .api_keys
            .iter_mut()
            .find(|api_key| api_key.key == key)
        else {
            anyhow::bail!("api key '{}' not found", key);
        };

        if api_key.service_id != service_id {
            api_key.service_id = service_id.to_string();
            guard.dirty = true;
        }
        Ok(())
    }

    pub async fn set_provider_model_options(
        &self,
        provider_id: i64,
        options: ProviderModelOptions<'_>,
    ) -> Result<()> {
        let mut guard = self.write_config().await;
        let p = guard
            .file
            .providers
            .get_mut(provider_id as usize)
            .ok_or_else(|| anyhow::anyhow!("provider not found"))?;
        if let Some(m) = options.default_model {
            p.default_model = m.to_string();
        }
        if let Some(m) = options.model_mapping {
            p.model_mapping = m.to_string();
        }
        guard.dirty = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::GatewayState;
    use std::path::Path;
    use tempfile::tempdir;

    #[tokio::test]
    async fn list_mode_views_reflects_default_and_bindings() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let state = GatewayState::load(Path::new(&config_path))
            .await
            .expect("load state");

        state.create_service("fast", "Fast").await;
        state.create_service("strong", "Strong").await;
        let provider_id = state
            .create_provider(
                "deepseek-main",
                "openai",
                "deepseek:global",
                Some("https://api.deepseek.com"),
                "sk-provider",
                None,
            )
            .await;
        state
            .bind_provider_to_service_with_priority("fast", provider_id, 10)
            .await
            .expect("bind provider");
        state
            .set_default_mode("fast")
            .await
            .expect("set default mode");

        let modes = state.list_mode_views().await;
        let fast = modes
            .iter()
            .find(|mode| mode.id == "fast")
            .expect("fast mode present");
        let strong = modes
            .iter()
            .find(|mode| mode.id == "strong")
            .expect("strong mode present");

        assert!(fast.is_default);
        assert!(!strong.is_default);
        assert_eq!(fast.providers.len(), 1);
        assert_eq!(fast.providers[0].name, "deepseek-main");
    }

    #[tokio::test]
    async fn rebind_api_key_service_preserves_limits_and_usage() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let state = GatewayState::load(Path::new(&config_path))
            .await
            .expect("load state");

        state.create_service("fast", "Fast").await;
        state.create_service("strong", "Strong").await;
        state
            .create_api_key("ugk_test_key", "fast", Some(100), Some(2.5), Some(3))
            .await;

        {
            let mut guard = state.write_config().await;
            let key = guard
                .file
                .api_keys
                .iter_mut()
                .find(|item| item.key == "ugk_test_key")
                .expect("key exists");
            key.used_quota = 37;
            key.is_active = false;
            guard.dirty = false;
        }

        state
            .rebind_api_key_service("ugk_test_key", "strong")
            .await
            .expect("rebind key");

        let keys = state.list_api_keys().await;
        let key = keys
            .iter()
            .find(|item| item.key == "ugk_test_key")
            .expect("key exists");

        assert_eq!(key.service_id, "strong");
        assert_eq!(key.used_quota, 37);
        assert_eq!(key.quota_limit, Some(100));
        assert_eq!(key.qps_limit, Some(2.5));
        assert_eq!(key.concurrency_limit, Some(3));
        assert!(!key.is_active);
    }

    #[tokio::test]
    async fn rebind_api_key_service_rejects_unknown_inputs() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let state = GatewayState::load(Path::new(&config_path))
            .await
            .expect("load state");

        state.create_service("fast", "Fast").await;
        state
            .create_api_key("ugk_test_key", "fast", None, None, None)
            .await;

        let missing_service = state
            .rebind_api_key_service("ugk_test_key", "missing")
            .await
            .expect_err("missing service should fail");
        assert!(
            missing_service
                .to_string()
                .contains("service 'missing' not found")
        );

        let missing_key = state
            .rebind_api_key_service("ugk_missing", "fast")
            .await
            .expect_err("missing key should fail");
        assert!(
            missing_key
                .to_string()
                .contains("api key 'ugk_missing' not found")
        );
    }

    #[tokio::test]
    async fn provider_views_update_and_delete_by_name() {
        use crate::ProviderModelOptions;

        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let state = GatewayState::load(Path::new(&config_path))
            .await
            .expect("load state");

        state.create_service("svc", "Service").await;

        let alpha_id = state
            .create_provider_with_models(
                "alpha",
                "openai",
                "moonshot:global",
                None,
                "sk-alpha",
                ProviderModelOptions {
                    default_model: Some("moonshot-v1-8k"),
                    model_mapping: Some("{\"gpt-4\":\"moonshot-v1-8k\"}"),
                },
            )
            .await;
        let _beta_id = state
            .create_provider_with_models(
                "beta",
                "anthropic",
                "",
                Some("https://api.anthropic.com"),
                "sk-beta",
                ProviderModelOptions {
                    default_model: None,
                    model_mapping: None,
                },
            )
            .await;

        state
            .bind_provider_to_service("svc", alpha_id)
            .await
            .expect("bind provider");

        let views = state.list_provider_views().await;
        assert_eq!(views.len(), 2);

        let alpha = views
            .iter()
            .find(|v| v.name == "alpha")
            .expect("alpha view present");
        assert_eq!(alpha.id, 0);
        assert_eq!(alpha.provider_type, "openai");
        assert_eq!(alpha.endpoint_id.as_deref(), Some("moonshot:global"));
        assert_eq!(alpha.base_url, None);
        assert_eq!(alpha.default_model.as_deref(), Some("moonshot-v1-8k"));
        assert_eq!(alpha.models, vec!["gpt-4"]);
        assert!(alpha.is_enabled);

        let beta = views
            .iter()
            .find(|v| v.name == "beta")
            .expect("beta view present");
        assert_eq!(beta.id, 1);
        assert_eq!(beta.provider_type, "anthropic");
        assert_eq!(beta.endpoint_id, None);
        assert_eq!(beta.base_url.as_deref(), Some("https://api.anthropic.com/"));
        assert_eq!(beta.default_model, None);
        assert!(beta.models.is_empty());

        state
            .update_provider_by_name("alpha", None, None, Some("moonshot-v1-32k"), None)
            .await
            .expect("update provider");

        let views = state.list_provider_views().await;
        let alpha = views
            .iter()
            .find(|v| v.name == "alpha")
            .expect("alpha view present");
        assert_eq!(alpha.default_model.as_deref(), Some("moonshot-v1-32k"));

        state
            .delete_provider_by_name("alpha")
            .await
            .expect("delete provider");

        let views = state.list_provider_views().await;
        assert_eq!(views.len(), 1);
        assert!(views.iter().all(|v| v.name != "alpha"));

        let file = state.config_snapshot().await;
        assert!(file.bindings.iter().all(|b| b.provider_name != "alpha"));

        let missing_update = state
            .update_provider_by_name("missing", None, None, Some("x"), None)
            .await
            .expect_err("update missing provider should fail");
        assert!(
            missing_update
                .to_string()
                .contains("provider 'missing' not found")
        );

        let missing_delete = state
            .delete_provider_by_name("missing")
            .await
            .expect_err("delete missing provider should fail");
        assert!(
            missing_delete
                .to_string()
                .contains("provider 'missing' not found")
        );
    }

    #[tokio::test]
    async fn list_service_models_trims_mapping_keys_and_sorts_aliases() {
        use crate::ProviderModelOptions;

        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let state = GatewayState::load(Path::new(&config_path))
            .await
            .expect("load state");

        state.create_service("svc", "Service").await;
        let provider_id = state
            .create_provider_with_models(
                "alpha",
                "openai",
                "moonshot:global",
                None,
                "sk-alpha",
                ProviderModelOptions {
                    default_model: Some("moonshot-v1-8k"),
                    model_mapping: Some(r#"{" zzz ":"z-model"," aaa ":"a-model"}"#),
                },
            )
            .await;
        state
            .bind_provider_to_service("svc", provider_id)
            .await
            .expect("bind provider");

        let models = state.list_service_models("svc").await;
        assert_eq!(models.len(), 3);

        // Aliases are trimmed and sorted lexicographically; default_model appended last.
        assert_eq!(models[0].alias, "aaa");
        assert_eq!(models[0].canonical.as_deref(), Some("a-model"));
        assert_eq!(models[1].alias, "zzz");
        assert_eq!(models[1].canonical.as_deref(), Some("z-model"));
        assert_eq!(models[2].alias, "moonshot-v1-8k");
        assert_eq!(models[2].canonical, None);

        // Flattened ids are deduplicated across expanded shapes.
        let ids = state.list_service_model_ids("svc").await;
        let id_values: Vec<&str> = ids.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(
            id_values,
            vec![
                "alpha/aaa",
                "aaa",
                "alpha/zzz",
                "zzz",
                "alpha/moonshot-v1-8k",
                "moonshot-v1-8k"
            ]
        );
    }

    #[tokio::test]
    async fn list_service_models_orders_providers_and_aliases() {
        use crate::ProviderModelOptions;

        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let state = GatewayState::load(Path::new(&config_path))
            .await
            .expect("load state");

        state.create_service("svc", "Service").await;

        let alpha_id = state
            .create_provider_with_models(
                "alpha",
                "openai",
                "moonshot:global",
                None,
                "sk-alpha",
                ProviderModelOptions {
                    default_model: Some("moonshot-v1-8k"),
                    model_mapping: Some("{\"gpt-4\":\"moonshot-v1-8k\"}"),
                },
            )
            .await;
        let beta_id = state
            .create_provider_with_models(
                "beta",
                "openai",
                "moonshot:global",
                None,
                "sk-beta",
                ProviderModelOptions {
                    default_model: Some("moonshot-v1-32k"),
                    model_mapping: Some("{\"gpt-4o\":\"moonshot-v1-32k\"}"),
                },
            )
            .await;

        state
            .bind_provider_to_service_with_priority("svc", beta_id, 5)
            .await
            .expect("bind beta");
        state
            .bind_provider_to_service_with_priority("svc", alpha_id, 10)
            .await
            .expect("bind alpha");

        let models = state.list_service_models("svc").await;
        assert_eq!(models.len(), 4);

        // Provider order: beta (prio 5) before alpha (prio 10).
        assert_eq!(models[0].owned_by, "beta");
        assert_eq!(models[0].id, "beta/gpt-4o");
        assert_eq!(models[0].alias, "gpt-4o");
        assert_eq!(models[0].canonical.as_deref(), Some("moonshot-v1-32k"));

        assert_eq!(models[1].owned_by, "beta");
        assert_eq!(models[1].id, "beta/moonshot-v1-32k");
        assert_eq!(models[1].alias, "moonshot-v1-32k");
        assert_eq!(models[1].canonical, None);

        assert_eq!(models[2].owned_by, "alpha");
        assert_eq!(models[2].id, "alpha/gpt-4");
        assert_eq!(models[2].alias, "gpt-4");
        assert_eq!(models[2].canonical.as_deref(), Some("moonshot-v1-8k"));

        assert_eq!(models[3].owned_by, "alpha");
        assert_eq!(models[3].id, "alpha/moonshot-v1-8k");
        assert_eq!(models[3].alias, "moonshot-v1-8k");
        assert_eq!(models[3].canonical, None);
    }

    #[tokio::test]
    async fn list_service_models_keeps_default_model_when_mapping_malformed() {
        use crate::ProviderModelOptions;

        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let state = GatewayState::load(Path::new(&config_path))
            .await
            .expect("load state");

        state.create_service("svc", "Service").await;
        let provider_id = state
            .create_provider_with_models(
                "alpha",
                "openai",
                "moonshot:global",
                None,
                "sk-alpha",
                ProviderModelOptions {
                    default_model: Some("moonshot-v1-8k"),
                    model_mapping: Some("not-json"),
                },
            )
            .await;
        state
            .bind_provider_to_service("svc", provider_id)
            .await
            .expect("bind provider");

        let models = state.list_service_models("svc").await;
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].alias, "moonshot-v1-8k");
        assert_eq!(models[0].canonical, None);
    }

    #[tokio::test]
    async fn list_service_model_ids_dedupes_expanded_ids() {
        use crate::ProviderModelOptions;

        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let state = GatewayState::load(Path::new(&config_path))
            .await
            .expect("load state");

        state.create_service("svc", "Service").await;

        let alpha_id = state
            .create_provider_with_models(
                "alpha",
                "openai",
                "moonshot:global",
                None,
                "sk-alpha",
                ProviderModelOptions {
                    default_model: None,
                    model_mapping: Some("{\"gpt-4\":\"a-gpt-4\"}"),
                },
            )
            .await;
        let beta_id = state
            .create_provider_with_models(
                "beta",
                "openai",
                "moonshot:global",
                None,
                "sk-beta",
                ProviderModelOptions {
                    default_model: None,
                    model_mapping: Some("{\"gpt-4\":\"b-gpt-4\"}"),
                },
            )
            .await;

        state
            .bind_provider_to_service("svc", alpha_id)
            .await
            .expect("bind alpha");
        state
            .bind_provider_to_service("svc", beta_id)
            .await
            .expect("bind beta");

        let ids = state.list_service_model_ids("svc").await;
        let id_values: Vec<&str> = ids.iter().map(|(id, _)| id.as_str()).collect();

        // Composite ids are unique; bare "gpt-4" appears only once (from alpha).
        assert_eq!(id_values, vec!["alpha/gpt-4", "gpt-4", "beta/gpt-4"]);
        assert_eq!(ids[1].1, "alpha");
    }

    #[tokio::test]
    async fn authorize_readonly_does_not_consume_quota() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let state = GatewayState::load(Path::new(&config_path))
            .await
            .expect("load state");

        state.create_service("svc", "Service").await;
        state
            .create_api_key("ugk_test_key", "svc", Some(100), None, None)
            .await;

        let before = state
            .find_gateway_api_key("ugk_test_key")
            .await
            .unwrap()
            .used_quota;

        let key = state.authorize_readonly("ugk_test_key").await;
        assert!(key.is_ok());

        let after = state
            .find_gateway_api_key("ugk_test_key")
            .await
            .unwrap()
            .used_quota;
        assert_eq!(before, after);
    }

    #[tokio::test]
    async fn authorize_readonly_rejects_inactive_key() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let state = GatewayState::load(Path::new(&config_path))
            .await
            .expect("load state");

        state.create_service("svc", "Service").await;
        state
            .create_api_key("ugk_inactive", "svc", None, None, None)
            .await;
        {
            let mut guard = state.write_config().await;
            let key = guard
                .file
                .api_keys
                .iter_mut()
                .find(|k| k.key == "ugk_inactive")
                .expect("key exists");
            key.is_active = false;
            guard.dirty = false;
        }

        let result = state.authorize_readonly("ugk_inactive").await;
        assert_eq!(result, Err(crate::AuthError::InactiveKey));
    }

    #[tokio::test]
    async fn authorize_readonly_rejects_missing_key() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let state = GatewayState::load(Path::new(&config_path))
            .await
            .expect("load state");

        let result = state.authorize_readonly("ugk_missing").await;
        assert_eq!(result, Err(crate::AuthError::InvalidKey));
    }
}
