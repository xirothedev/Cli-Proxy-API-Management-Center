import { useMemo, useState, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { ConfigSection } from '@/components/config/ConfigSection';
import { useNotificationStore } from '@/stores';
import styles from './VisualConfigEditor.module.scss';
import { copyToClipboard } from '@/utils/clipboard';
import type {
  PayloadFilterRule,
  PayloadModelEntry,
  PayloadParamEntry,
  PayloadParamValueType,
  PayloadRule,
  VisualConfigValues,
} from '@/types/visualConfig';
import { makeClientId } from '@/types/visualConfig';
import {
  VISUAL_CONFIG_PAYLOAD_VALUE_TYPE_OPTIONS,
  VISUAL_CONFIG_PROTOCOL_OPTIONS,
} from '@/hooks/useVisualConfig';
import { maskApiKey } from '@/utils/format';
import { apiClient } from '@/services/api/client';
import { authFilesApi } from '@/services/api/authFiles';
import { isValidApiKeyCharset } from '@/utils/validation';

interface VisualConfigEditorProps {
  values: VisualConfigValues;
  disabled?: boolean;
  onChange: (values: Partial<VisualConfigValues>) => void;
}

type ToggleRowProps = {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
};

function ToggleRow({ title, description, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 220 }}>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
        {description && (
          <div style={{ marginTop: 4, fontSize: 13, color: 'var(--text-secondary)' }}>
            {description}
          </div>
        )}
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} ariaLabel={title} />
    </div>
  );
}

function SectionGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border-color)', margin: '16px 0' }} />;
}

type AuthMappingRecord = Record<string, string[]>;
type AuthTarget = { authIndex: string; label: string };

const AUTH_INDEX_HEX16 = /^[0-9a-f]{16}$/i;

function normalizeAuthIndex(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (AUTH_INDEX_HEX16.test(raw)) return raw.toLowerCase();
  const m = raw.match(/\b([0-9a-f]{16})\b/i);
  return m ? m[1].toLowerCase() : '';
}

async function fetchClientAuthMappings(): Promise<AuthMappingRecord> {
  const payloads: unknown[] = [];
  try {
    payloads.push(await apiClient.get('/client-auth-mappings'));
  } catch {
    payloads.push(await apiClient.get('/v0/management/client-auth-mappings'));
  }
  const payload = payloads[0] as Record<string, unknown>;
  const source = (payload['client-auth-mappings'] ?? payload.clientAuthMappings ?? payload) as unknown;
  const out: AuthMappingRecord = {};

  if (Array.isArray(source)) {
    source.forEach((entry) => {
      const row = entry as Record<string, unknown>;
      const idx = normalizeAuthIndex(row['auth-index'] ?? row.authIndex ?? row.index ?? row.id);
      if (!idx) return;
      const keys = Array.isArray(row['api-keys'])
        ? row['api-keys']
        : Array.isArray(row.apiKeys)
          ? row.apiKeys
          : [];
      out[idx] = Array.from(
        new Set(keys.map((item) => String(item ?? '').trim()).filter(Boolean))
      );
    });
    return out;
  }

  if (source && typeof source === 'object') {
    Object.entries(source as Record<string, unknown>).forEach(([idxRaw, keysRaw]) => {
      const idx = normalizeAuthIndex(idxRaw);
      if (!idx) return;
      const keys = Array.isArray(keysRaw) ? keysRaw : [];
      out[idx] = Array.from(new Set(keys.map((item) => String(item ?? '').trim()).filter(Boolean)));
    });
  }

  return out;
}

async function saveClientAuthMappings(next: AuthMappingRecord): Promise<void> {
  try {
    await apiClient.put('/client-auth-mappings', next);
  } catch {
    await apiClient.put('/v0/management/client-auth-mappings', next);
  }
}

async function deriveAuthIndexFromName(name: string): Promise<string> {
  const clean = String(name ?? '').trim();
  if (!clean) return '';
  try {
    const seed = `file:${clean}`;
    const bytes = new TextEncoder().encode(seed);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const view = new Uint8Array(digest).slice(0, 8);
    return Array.from(view)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}

async function fetchAuthTargets(): Promise<AuthTarget[]> {
  const data = await authFilesApi.list();
  const files = Array.isArray(data.files) ? data.files : [];
  const out: AuthTarget[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const name = String(file.name ?? file.filename ?? '').trim();
    const prefix = String((file as Record<string, unknown>).prefix ?? '').trim();
    let idx = normalizeAuthIndex(
      (file as Record<string, unknown>).authIndex ??
        (file as Record<string, unknown>)['auth-index']
    );
    if (!idx && name) {
      idx = await deriveAuthIndexFromName(name);
    }
    if (!idx || seen.has(idx)) continue;
    seen.add(idx);
    const labelBase = prefix || name || 'auth-index';
    out.push({ authIndex: idx, label: `${labelBase} (${idx})` });
  }

  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function ApiKeysCardEditor({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (nextValue: string) => void;
}) {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const apiKeys = useMemo(
    () =>
      value
        .split('\n')
        .map((key) => key.trim())
        .filter(Boolean),
    [value]
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [formError, setFormError] = useState('');
  const [mappingTargets, setMappingTargets] = useState<AuthTarget[]>([]);
  const [mappingSelected, setMappingSelected] = useState<string[]>([]);
  const [mappingError, setMappingError] = useState('');
  const [mappingLoading, setMappingLoading] = useState(false);

  function generateSecureApiKey(): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const array = new Uint8Array(17);
    crypto.getRandomValues(array);
    return 'sk-' + Array.from(array, (b) => charset[b % charset.length]).join('');
  }

  useEffect(() => {
    if (!modalOpen) return;
    let active = true;

    const loadMappings = async () => {
      setMappingLoading(true);
      setMappingError('');
      try {
        const [targets, mappings] = await Promise.all([fetchAuthTargets(), fetchClientAuthMappings()]);
        if (!active) return;
        setMappingTargets(targets);

        const key = String(inputValue || '').trim();
        if (!key) {
          setMappingSelected([]);
        } else {
          const selected = Object.entries(mappings)
            .filter(([, keys]) => keys.includes(key))
            .map(([idx]) => idx);
          setMappingSelected(selected);
        }
      } catch (err) {
        if (!active) return;
        const message = err instanceof Error ? err.message : String(err || 'Unknown error');
        setMappingError(message);
      } finally {
        if (active) setMappingLoading(false);
      }
    };

    loadMappings();

    return () => {
      active = false;
    };
  }, [modalOpen, inputValue]);

  const openAddModal = () => {
    setEditingIndex(null);
    setInputValue('');
    setFormError('');
    setModalOpen(true);
  };

  const openEditModal = (index: number) => {
    setEditingIndex(index);
    setInputValue(apiKeys[index] ?? '');
    setFormError('');
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setInputValue('');
    setEditingIndex(null);
    setFormError('');
  };

  const updateApiKeys = (nextKeys: string[]) => {
    onChange(nextKeys.join('\n'));
  };

  const handleDelete = (index: number) => {
    updateApiKeys(apiKeys.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setFormError(t('config_management.visual.api_keys.error_empty'));
      return;
    }
    if (!isValidApiKeyCharset(trimmed)) {
      setFormError(t('config_management.visual.api_keys.error_invalid'));
      return;
    }

    const previousKey = editingIndex !== null ? String(apiKeys[editingIndex] ?? '').trim() : '';

    const nextKeys =
      editingIndex === null
        ? [...apiKeys, trimmed]
        : apiKeys.map((key, idx) => (idx === editingIndex ? trimmed : key));

    updateApiKeys(nextKeys);

    try {
      const mappings = await fetchClientAuthMappings();
      const selectedSet = new Set(mappingSelected.map((item) => normalizeAuthIndex(item)).filter(Boolean));
      const allIndexes = new Set<string>([
        ...Object.keys(mappings),
        ...mappingTargets.map((target) => target.authIndex),
      ]);

      const nextMappings: AuthMappingRecord = {};
      allIndexes.forEach((idx) => {
        const base = (mappings[idx] ?? []).filter((apiKey) => apiKey !== previousKey && apiKey !== trimmed);
        if (selectedSet.has(idx)) base.push(trimmed);
        const deduped = Array.from(new Set(base));
        if (deduped.length) nextMappings[idx] = deduped;
      });

      await saveClientAuthMappings(nextMappings);
      showNotification(t('notification.save_success'), 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || 'Unknown error');
      showNotification(`Auth mapping sync failed: ${message}`, 'error');
    }

    closeModal();
  };

  const handleCopy = async (apiKey: string) => {
    const copied = await copyToClipboard(apiKey);
    showNotification(
      t(copied ? 'notification.link_copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  const handleGenerate = () => {
    setInputValue(generateSecureApiKey());
    setFormError('');
  };

  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <label style={{ margin: 0 }}>{t('config_management.visual.api_keys.label')}</label>
        <Button size="sm" onClick={openAddModal} disabled={disabled}>
          {t('config_management.visual.api_keys.add')}
        </Button>
      </div>

      {apiKeys.length === 0 ? (
        <div
          style={{
            border: '1px dashed var(--border-color)',
            borderRadius: 12,
            padding: 16,
            color: 'var(--text-secondary)',
            textAlign: 'center',
          }}
        >
          {t('config_management.visual.api_keys.empty')}
        </div>
      ) : (
        <div className="item-list" style={{ marginTop: 4 }}>
          {apiKeys.map((key, index) => (
            <div key={`${key}-${index}`} className="item-row">
              <div className="item-meta">
                <div className="pill">#{index + 1}</div>
                <div className="item-title">API Key</div>
                <div className="item-subtitle">{maskApiKey(String(key || ''))}</div>
              </div>
              <div className="item-actions">
                <Button variant="secondary" size="sm" onClick={() => handleCopy(key)} disabled={disabled}>
                  {t('common.copy')}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => openEditModal(index)} disabled={disabled}>
                  {t('config_management.visual.common.edit')}
                </Button>
                <Button variant="danger" size="sm" onClick={() => handleDelete(index)} disabled={disabled}>
                  {t('config_management.visual.common.delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="hint">{t('config_management.visual.api_keys.hint')}</div>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editingIndex !== null ? t('config_management.visual.api_keys.edit_title') : t('config_management.visual.api_keys.add_title')}
        footer={
          <>
            <Button variant="secondary" onClick={closeModal} disabled={disabled}>
              {t('config_management.visual.common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={disabled}>
              {editingIndex !== null ? t('config_management.visual.common.update') : t('config_management.visual.common.add')}
            </Button>
          </>
        }
      >
        <Input
          label={t('config_management.visual.api_keys.input_label')}
          placeholder={t('config_management.visual.api_keys.input_placeholder')}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          disabled={disabled}
          error={formError || undefined}
          hint={t('config_management.visual.api_keys.input_hint')}
          style={{ paddingRight: 148 }}
          rightElement={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleGenerate}
              disabled={disabled}
            >
              {t('config_management.visual.api_keys.generate')}
            </Button>
          }
        />

        <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
          <label style={{ marginBottom: 6 }}>Auth Mapping</label>
          <div className="hint" style={{ marginBottom: 8 }}>
            Select auth-index targets for this API key.
          </div>

          {mappingLoading ? (
            <div className="hint">Loading auth mapping data...</div>
          ) : mappingError ? (
            <div className="error-box">Failed to load auth mapping data: {mappingError}</div>
          ) : mappingTargets.length === 0 ? (
            <div className="hint">No auth-index targets available.</div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 6,
                maxHeight: 220,
                overflow: 'auto',
                paddingRight: 4,
              }}
            >
              {mappingTargets.map((target) => {
                const checked = mappingSelected.includes(target.authIndex);
                return (
                  <label
                    key={target.authIndex}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      border: '1px solid var(--border-color)',
                      borderRadius: 8,
                      background: 'var(--bg-secondary)',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      value={target.authIndex}
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) => {
                        const idx = e.target.value;
                        setMappingSelected((prev) =>
                          e.target.checked ? Array.from(new Set([...prev, idx])) : prev.filter((item) => item !== idx)
                        );
                      }}
                    />
                    <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{target.label}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

function StringListEditor({
  value,
  disabled,
  placeholder,
  onChange,
}: {
  value: string[];
  disabled?: boolean;
  placeholder?: string;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const items = value.length ? value : [];

  const updateItem = (index: number, nextValue: string) =>
    onChange(items.map((item, i) => (i === index ? nextValue : item)));
  const addItem = () => onChange([...items, '']);
  const removeItem = (index: number) => onChange(items.filter((_, i) => i !== index));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item, index) => (
        <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder={placeholder}
            value={item}
            onChange={(e) => updateItem(index, e.target.value)}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <Button variant="ghost" size="sm" onClick={() => removeItem(index)} disabled={disabled}>
            {t('config_management.visual.common.delete')}
          </Button>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="secondary" size="sm" onClick={addItem} disabled={disabled}>
          {t('config_management.visual.common.add')}
        </Button>
      </div>
    </div>
  );
}

function PayloadRulesEditor({
  value,
  disabled,
  protocolFirst = false,
  onChange,
}: {
  value: PayloadRule[];
  disabled?: boolean;
  protocolFirst?: boolean;
  onChange: (next: PayloadRule[]) => void;
}) {
  const { t } = useTranslation();
  const rules = value.length ? value : [];
  const protocolOptions = useMemo(
    () =>
      VISUAL_CONFIG_PROTOCOL_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey, { defaultValue: option.defaultLabel }),
      })),
    [t]
  );
  const payloadValueTypeOptions = useMemo(
    () =>
      VISUAL_CONFIG_PAYLOAD_VALUE_TYPE_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey, { defaultValue: option.defaultLabel }),
      })),
    [t]
  );

  const addRule = () => onChange([...rules, { id: makeClientId(), models: [], params: [] }]);
  const removeRule = (ruleIndex: number) => onChange(rules.filter((_, i) => i !== ruleIndex));

  const updateRule = (ruleIndex: number, patch: Partial<PayloadRule>) =>
    onChange(rules.map((rule, i) => (i === ruleIndex ? { ...rule, ...patch } : rule)));

  const addModel = (ruleIndex: number) => {
    const rule = rules[ruleIndex];
    const nextModel: PayloadModelEntry = { id: makeClientId(), name: '', protocol: undefined };
    updateRule(ruleIndex, { models: [...rule.models, nextModel] });
  };

  const removeModel = (ruleIndex: number, modelIndex: number) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, { models: rule.models.filter((_, i) => i !== modelIndex) });
  };

  const updateModel = (ruleIndex: number, modelIndex: number, patch: Partial<PayloadModelEntry>) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, {
      models: rule.models.map((m, i) => (i === modelIndex ? { ...m, ...patch } : m)),
    });
  };

  const addParam = (ruleIndex: number) => {
    const rule = rules[ruleIndex];
    const nextParam: PayloadParamEntry = {
      id: makeClientId(),
      path: '',
      valueType: 'string',
      value: '',
    };
    updateRule(ruleIndex, { params: [...rule.params, nextParam] });
  };

  const removeParam = (ruleIndex: number, paramIndex: number) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, { params: rule.params.filter((_, i) => i !== paramIndex) });
  };

  const updateParam = (ruleIndex: number, paramIndex: number, patch: Partial<PayloadParamEntry>) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, {
      params: rule.params.map((p, i) => (i === paramIndex ? { ...p, ...patch } : p)),
    });
  };

  const getValuePlaceholder = (valueType: PayloadParamValueType) => {
    switch (valueType) {
      case 'string':
        return t('config_management.visual.payload_rules.value_string');
      case 'number':
        return t('config_management.visual.payload_rules.value_number');
      case 'boolean':
        return t('config_management.visual.payload_rules.value_boolean');
      case 'json':
        return t('config_management.visual.payload_rules.value_json');
      default:
        return t('config_management.visual.payload_rules.value_default');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rules.map((rule, ruleIndex) => (
        <div
          key={rule.id}
          style={{
            border: '1px solid var(--border-color)',
            borderRadius: 12,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{t('config_management.visual.payload_rules.rule')} {ruleIndex + 1}</div>
            <Button variant="ghost" size="sm" onClick={() => removeRule(ruleIndex)} disabled={disabled}>
              {t('config_management.visual.common.delete')}
            </Button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('config_management.visual.payload_rules.models')}</div>
            {(rule.models.length ? rule.models : []).map((model, modelIndex) => (
              <div
                key={model.id}
                className={[styles.payloadRuleModelRow, protocolFirst ? styles.payloadRuleModelRowProtocolFirst : '']
                  .filter(Boolean)
                  .join(' ')}
              >
                {protocolFirst ? (
                  <>
                    <Select
                      value={model.protocol ?? ''}
                      options={protocolOptions}
                      disabled={disabled}
                      ariaLabel={t('config_management.visual.payload_rules.provider_type')}
                      onChange={(nextValue) =>
                        updateModel(ruleIndex, modelIndex, {
                          protocol: (nextValue || undefined) as PayloadModelEntry['protocol'],
                        })
                      }
                    />
                    <input
                      className="input"
                      placeholder={t('config_management.visual.payload_rules.model_name')}
                      value={model.name}
                      onChange={(e) => updateModel(ruleIndex, modelIndex, { name: e.target.value })}
                      disabled={disabled}
                    />
                  </>
                ) : (
                  <>
                    <input
                      className="input"
                      placeholder={t('config_management.visual.payload_rules.model_name')}
                      value={model.name}
                      onChange={(e) => updateModel(ruleIndex, modelIndex, { name: e.target.value })}
                      disabled={disabled}
                    />
                    <Select
                      value={model.protocol ?? ''}
                      options={protocolOptions}
                      disabled={disabled}
                      ariaLabel={t('config_management.visual.payload_rules.provider_type')}
                      onChange={(nextValue) =>
                        updateModel(ruleIndex, modelIndex, {
                          protocol: (nextValue || undefined) as PayloadModelEntry['protocol'],
                        })
                      }
                    />
                  </>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.payloadRowActionButton}
                  onClick={() => removeModel(ruleIndex, modelIndex)}
                  disabled={disabled}
                >
                  {t('config_management.visual.common.delete')}
                </Button>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="secondary" size="sm" onClick={() => addModel(ruleIndex)} disabled={disabled}>
                {t('config_management.visual.payload_rules.add_model')}
              </Button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('config_management.visual.payload_rules.params')}</div>
            {(rule.params.length ? rule.params : []).map((param, paramIndex) => (
              <div key={param.id} className={styles.payloadRuleParamRow}>
                <input
                  className="input"
                  placeholder={t('config_management.visual.payload_rules.json_path')}
                  value={param.path}
                  onChange={(e) => updateParam(ruleIndex, paramIndex, { path: e.target.value })}
                  disabled={disabled}
                />
                <Select
                  value={param.valueType}
                  options={payloadValueTypeOptions}
                  disabled={disabled}
                  ariaLabel={t('config_management.visual.payload_rules.param_type')}
                  onChange={(nextValue) =>
                    updateParam(ruleIndex, paramIndex, { valueType: nextValue as PayloadParamValueType })
                  }
                />
                <input
                  className="input"
                  placeholder={getValuePlaceholder(param.valueType)}
                  value={param.value}
                  onChange={(e) => updateParam(ruleIndex, paramIndex, { value: e.target.value })}
                  disabled={disabled}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.payloadRowActionButton}
                  onClick={() => removeParam(ruleIndex, paramIndex)}
                  disabled={disabled}
                >
                  {t('config_management.visual.common.delete')}
                </Button>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="secondary" size="sm" onClick={() => addParam(ruleIndex)} disabled={disabled}>
                {t('config_management.visual.payload_rules.add_param')}
              </Button>
            </div>
          </div>
        </div>
      ))}

      {rules.length === 0 && (
        <div
          style={{
            border: '1px dashed var(--border-color)',
            borderRadius: 12,
            padding: 16,
            color: 'var(--text-secondary)',
            textAlign: 'center',
          }}
        >
          {t('config_management.visual.payload_rules.no_rules')}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="secondary" size="sm" onClick={addRule} disabled={disabled}>
          {t('config_management.visual.payload_rules.add_rule')}
        </Button>
      </div>
    </div>
  );
}

function PayloadFilterRulesEditor({
  value,
  disabled,
  onChange,
}: {
  value: PayloadFilterRule[];
  disabled?: boolean;
  onChange: (next: PayloadFilterRule[]) => void;
}) {
  const { t } = useTranslation();
  const rules = value.length ? value : [];
  const protocolOptions = useMemo(
    () =>
      VISUAL_CONFIG_PROTOCOL_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey, { defaultValue: option.defaultLabel }),
      })),
    [t]
  );

  const addRule = () => onChange([...rules, { id: makeClientId(), models: [], params: [] }]);
  const removeRule = (ruleIndex: number) => onChange(rules.filter((_, i) => i !== ruleIndex));

  const updateRule = (ruleIndex: number, patch: Partial<PayloadFilterRule>) =>
    onChange(rules.map((rule, i) => (i === ruleIndex ? { ...rule, ...patch } : rule)));

  const addModel = (ruleIndex: number) => {
    const rule = rules[ruleIndex];
    const nextModel: PayloadModelEntry = { id: makeClientId(), name: '', protocol: undefined };
    updateRule(ruleIndex, { models: [...rule.models, nextModel] });
  };

  const removeModel = (ruleIndex: number, modelIndex: number) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, { models: rule.models.filter((_, i) => i !== modelIndex) });
  };

  const updateModel = (ruleIndex: number, modelIndex: number, patch: Partial<PayloadModelEntry>) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, {
      models: rule.models.map((m, i) => (i === modelIndex ? { ...m, ...patch } : m)),
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rules.map((rule, ruleIndex) => (
        <div
          key={rule.id}
          style={{
            border: '1px solid var(--border-color)',
            borderRadius: 12,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{t('config_management.visual.payload_rules.rule')} {ruleIndex + 1}</div>
            <Button variant="ghost" size="sm" onClick={() => removeRule(ruleIndex)} disabled={disabled}>
              {t('config_management.visual.common.delete')}
            </Button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('config_management.visual.payload_rules.models')}</div>
            {rule.models.map((model, modelIndex) => (
              <div key={model.id} className={styles.payloadFilterModelRow}>
                <input
                  className="input"
                  placeholder={t('config_management.visual.payload_rules.model_name')}
                  value={model.name}
                  onChange={(e) => updateModel(ruleIndex, modelIndex, { name: e.target.value })}
                  disabled={disabled}
                />
                <Select
                  value={model.protocol ?? ''}
                  options={protocolOptions}
                  disabled={disabled}
                  ariaLabel={t('config_management.visual.payload_rules.provider_type')}
                  onChange={(nextValue) =>
                    updateModel(ruleIndex, modelIndex, {
                      protocol: (nextValue || undefined) as PayloadModelEntry['protocol'],
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.payloadRowActionButton}
                  onClick={() => removeModel(ruleIndex, modelIndex)}
                  disabled={disabled}
                >
                  {t('config_management.visual.common.delete')}
                </Button>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="secondary" size="sm" onClick={() => addModel(ruleIndex)} disabled={disabled}>
                {t('config_management.visual.payload_rules.add_model')}
              </Button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('config_management.visual.payload_rules.remove_params')}</div>
            <StringListEditor
              value={rule.params}
              disabled={disabled}
              placeholder={t('config_management.visual.payload_rules.json_path_filter')}
              onChange={(params) => updateRule(ruleIndex, { params })}
            />
          </div>
        </div>
      ))}

      {rules.length === 0 && (
        <div
          style={{
            border: '1px dashed var(--border-color)',
            borderRadius: 12,
            padding: 16,
            color: 'var(--text-secondary)',
            textAlign: 'center',
          }}
        >
          {t('config_management.visual.payload_rules.no_rules')}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="secondary" size="sm" onClick={addRule} disabled={disabled}>
          {t('config_management.visual.payload_rules.add_rule')}
        </Button>
      </div>
    </div>
  );
}

export function VisualConfigEditor({ values, disabled = false, onChange }: VisualConfigEditorProps) {
  const { t } = useTranslation();
  const isKeepaliveDisabled = values.streaming.keepaliveSeconds === '' || values.streaming.keepaliveSeconds === '0';
  const isNonstreamKeepaliveDisabled =
    values.streaming.nonstreamKeepaliveInterval === '' || values.streaming.nonstreamKeepaliveInterval === '0';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ConfigSection title={t('config_management.visual.sections.server.title')} description={t('config_management.visual.sections.server.description')}>
        <SectionGrid>
          <Input
            label={t('config_management.visual.sections.server.host')}
            placeholder="0.0.0.0"
            value={values.host}
            onChange={(e) => onChange({ host: e.target.value })}
            disabled={disabled}
          />
          <Input
            label={t('config_management.visual.sections.server.port')}
            type="number"
            placeholder="8317"
            value={values.port}
            onChange={(e) => onChange({ port: e.target.value })}
            disabled={disabled}
          />
        </SectionGrid>
      </ConfigSection>

      <ConfigSection title={t('config_management.visual.sections.tls.title')} description={t('config_management.visual.sections.tls.description')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ToggleRow
            title={t('config_management.visual.sections.tls.enable')}
            description={t('config_management.visual.sections.tls.enable_desc')}
            checked={values.tlsEnable}
            disabled={disabled}
            onChange={(tlsEnable) => onChange({ tlsEnable })}
          />
          {values.tlsEnable && (
            <>
              <Divider />
              <SectionGrid>
                <Input
                  label={t('config_management.visual.sections.tls.cert')}
                  placeholder="/path/to/cert.pem"
                  value={values.tlsCert}
                  onChange={(e) => onChange({ tlsCert: e.target.value })}
                  disabled={disabled}
                />
                <Input
                  label={t('config_management.visual.sections.tls.key')}
                  placeholder="/path/to/key.pem"
                  value={values.tlsKey}
                  onChange={(e) => onChange({ tlsKey: e.target.value })}
                  disabled={disabled}
                />
              </SectionGrid>
            </>
          )}
        </div>
      </ConfigSection>

      <ConfigSection title={t('config_management.visual.sections.remote.title')} description={t('config_management.visual.sections.remote.description')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ToggleRow
            title={t('config_management.visual.sections.remote.allow_remote')}
            description={t('config_management.visual.sections.remote.allow_remote_desc')}
            checked={values.rmAllowRemote}
            disabled={disabled}
            onChange={(rmAllowRemote) => onChange({ rmAllowRemote })}
          />
          <ToggleRow
            title={t('config_management.visual.sections.remote.disable_panel')}
            description={t('config_management.visual.sections.remote.disable_panel_desc')}
            checked={values.rmDisableControlPanel}
            disabled={disabled}
            onChange={(rmDisableControlPanel) => onChange({ rmDisableControlPanel })}
          />
          <SectionGrid>
            <Input
              label={t('config_management.visual.sections.remote.secret_key')}
              type="password"
              placeholder={t('config_management.visual.sections.remote.secret_key_placeholder')}
              value={values.rmSecretKey}
              onChange={(e) => onChange({ rmSecretKey: e.target.value })}
              disabled={disabled}
            />
            <Input
              label={t('config_management.visual.sections.remote.panel_repo')}
              placeholder="https://github.com/router-for-me/Cli-Proxy-API-Management-Center"
              value={values.rmPanelRepo}
              onChange={(e) => onChange({ rmPanelRepo: e.target.value })}
              disabled={disabled}
            />
          </SectionGrid>
        </div>
      </ConfigSection>

      <ConfigSection title={t('config_management.visual.sections.auth.title')} description={t('config_management.visual.sections.auth.description')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input
            label={t('config_management.visual.sections.auth.auth_dir')}
            placeholder="~/.cli-proxy-api"
            value={values.authDir}
            onChange={(e) => onChange({ authDir: e.target.value })}
            disabled={disabled}
            hint={t('config_management.visual.sections.auth.auth_dir_hint')}
          />
          <ApiKeysCardEditor
            value={values.apiKeysText}
            disabled={disabled}
            onChange={(apiKeysText) => onChange({ apiKeysText })}
          />
        </div>
      </ConfigSection>

      <ConfigSection title={t('config_management.visual.sections.system.title')} description={t('config_management.visual.sections.system.description')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SectionGrid>
            <ToggleRow
              title={t('config_management.visual.sections.system.debug')}
              description={t('config_management.visual.sections.system.debug_desc')}
              checked={values.debug}
              disabled={disabled}
              onChange={(debug) => onChange({ debug })}
            />
            <ToggleRow
              title={t('config_management.visual.sections.system.commercial_mode')}
              description={t('config_management.visual.sections.system.commercial_mode_desc')}
              checked={values.commercialMode}
              disabled={disabled}
              onChange={(commercialMode) => onChange({ commercialMode })}
            />
            <ToggleRow
              title={t('config_management.visual.sections.system.logging_to_file')}
              description={t('config_management.visual.sections.system.logging_to_file_desc')}
              checked={values.loggingToFile}
              disabled={disabled}
              onChange={(loggingToFile) => onChange({ loggingToFile })}
            />
            <ToggleRow
              title={t('config_management.visual.sections.system.usage_statistics')}
              description={t('config_management.visual.sections.system.usage_statistics_desc')}
              checked={values.usageStatisticsEnabled}
              disabled={disabled}
              onChange={(usageStatisticsEnabled) => onChange({ usageStatisticsEnabled })}
            />
          </SectionGrid>

          <SectionGrid>
            <Input
              label={t('config_management.visual.sections.system.logs_max_size')}
              type="number"
              placeholder="0"
              value={values.logsMaxTotalSizeMb}
              onChange={(e) => onChange({ logsMaxTotalSizeMb: e.target.value })}
              disabled={disabled}
            />
          </SectionGrid>
        </div>
      </ConfigSection>

      <ConfigSection title={t('config_management.visual.sections.network.title')} description={t('config_management.visual.sections.network.description')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SectionGrid>
            <Input
              label={t('config_management.visual.sections.network.proxy_url')}
              placeholder="socks5://user:pass@127.0.0.1:1080/"
              value={values.proxyUrl}
              onChange={(e) => onChange({ proxyUrl: e.target.value })}
              disabled={disabled}
            />
            <Input
              label={t('config_management.visual.sections.network.request_retry')}
              type="number"
              placeholder="3"
              value={values.requestRetry}
              onChange={(e) => onChange({ requestRetry: e.target.value })}
              disabled={disabled}
            />
            <Input
              label={t('config_management.visual.sections.network.max_retry_interval')}
              type="number"
              placeholder="30"
              value={values.maxRetryInterval}
              onChange={(e) => onChange({ maxRetryInterval: e.target.value })}
              disabled={disabled}
            />
            <div className="form-group">
              <label>{t('config_management.visual.sections.network.routing_strategy')}</label>
              <Select
                value={values.routingStrategy}
                options={[
                  { value: 'round-robin', label: t('config_management.visual.sections.network.strategy_round_robin') },
                  { value: 'fill-first', label: t('config_management.visual.sections.network.strategy_fill_first') },
                ]}
                disabled={disabled}
                ariaLabel={t('config_management.visual.sections.network.routing_strategy')}
                onChange={(nextValue) =>
                  onChange({ routingStrategy: nextValue as VisualConfigValues['routingStrategy'] })
                }
              />
              <div className="hint">{t('config_management.visual.sections.network.routing_strategy_hint')}</div>
            </div>
          </SectionGrid>

          <ToggleRow
            title={t('config_management.visual.sections.network.force_model_prefix')}
            description={t('config_management.visual.sections.network.force_model_prefix_desc')}
            checked={values.forceModelPrefix}
            disabled={disabled}
            onChange={(forceModelPrefix) => onChange({ forceModelPrefix })}
          />
          <ToggleRow
            title={t('config_management.visual.sections.network.ws_auth')}
            description={t('config_management.visual.sections.network.ws_auth_desc')}
            checked={values.wsAuth}
            disabled={disabled}
            onChange={(wsAuth) => onChange({ wsAuth })}
          />
        </div>
      </ConfigSection>

      <ConfigSection title={t('config_management.visual.sections.quota.title')} description={t('config_management.visual.sections.quota.description')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ToggleRow
            title={t('config_management.visual.sections.quota.switch_project')}
            description={t('config_management.visual.sections.quota.switch_project_desc')}
            checked={values.quotaSwitchProject}
            disabled={disabled}
            onChange={(quotaSwitchProject) => onChange({ quotaSwitchProject })}
          />
          <ToggleRow
            title={t('config_management.visual.sections.quota.switch_preview_model')}
            description={t('config_management.visual.sections.quota.switch_preview_model_desc')}
            checked={values.quotaSwitchPreviewModel}
            disabled={disabled}
            onChange={(quotaSwitchPreviewModel) => onChange({ quotaSwitchPreviewModel })}
          />
        </div>
      </ConfigSection>

      <ConfigSection title={t('config_management.visual.sections.streaming.title')} description={t('config_management.visual.sections.streaming.description')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SectionGrid>
            <div className="form-group">
              <label>{t('config_management.visual.sections.streaming.keepalive_seconds')}</label>
              <div style={{ position: 'relative' }}>
                <input
                  className="input"
                  type="number"
                  placeholder="0"
                  value={values.streaming.keepaliveSeconds}
                  onChange={(e) =>
                    onChange({ streaming: { ...values.streaming, keepaliveSeconds: e.target.value } })
                  }
                  disabled={disabled}
                />
                {isKeepaliveDisabled && (
                  <span
                    style={{
                      position: 'absolute',
                      right: 10,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      background: 'var(--bg-secondary)',
                      padding: '2px 8px',
                      borderRadius: 999,
                      border: '1px solid var(--border-color)',
                    }}
                  >
                    {t('config_management.visual.sections.streaming.disabled')}
                  </span>
                )}
              </div>
              <div className="hint">{t('config_management.visual.sections.streaming.keepalive_hint')}</div>
            </div>
            <Input
              label={t('config_management.visual.sections.streaming.bootstrap_retries')}
              type="number"
              placeholder="1"
              value={values.streaming.bootstrapRetries}
              onChange={(e) => onChange({ streaming: { ...values.streaming, bootstrapRetries: e.target.value } })}
              disabled={disabled}
              hint={t('config_management.visual.sections.streaming.bootstrap_hint')}
            />
          </SectionGrid>

          <SectionGrid>
            <div className="form-group">
              <label>{t('config_management.visual.sections.streaming.nonstream_keepalive')}</label>
              <div style={{ position: 'relative' }}>
                <input
                  className="input"
                  type="number"
                  placeholder="0"
                  value={values.streaming.nonstreamKeepaliveInterval}
                  onChange={(e) =>
                    onChange({
                      streaming: { ...values.streaming, nonstreamKeepaliveInterval: e.target.value },
                    })
                  }
                  disabled={disabled}
                />
                {isNonstreamKeepaliveDisabled && (
                  <span
                    style={{
                      position: 'absolute',
                      right: 10,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      background: 'var(--bg-secondary)',
                      padding: '2px 8px',
                      borderRadius: 999,
                      border: '1px solid var(--border-color)',
                    }}
                  >
                    {t('config_management.visual.sections.streaming.disabled')}
                  </span>
                )}
              </div>
              <div className="hint">
                {t('config_management.visual.sections.streaming.nonstream_keepalive_hint')}
              </div>
            </div>
          </SectionGrid>
        </div>
      </ConfigSection>

      <ConfigSection title={t('config_management.visual.sections.payload.title')} description={t('config_management.visual.sections.payload.description')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{t('config_management.visual.sections.payload.default_rules')}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
              {t('config_management.visual.sections.payload.default_rules_desc')}
            </div>
            <PayloadRulesEditor
              value={values.payloadDefaultRules}
              disabled={disabled}
              onChange={(payloadDefaultRules) => onChange({ payloadDefaultRules })}
            />
          </div>

          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{t('config_management.visual.sections.payload.override_rules')}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
              {t('config_management.visual.sections.payload.override_rules_desc')}
            </div>
            <PayloadRulesEditor
              value={values.payloadOverrideRules}
              disabled={disabled}
              protocolFirst
              onChange={(payloadOverrideRules) => onChange({ payloadOverrideRules })}
            />
          </div>

          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{t('config_management.visual.sections.payload.filter_rules')}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
              {t('config_management.visual.sections.payload.filter_rules_desc')}
            </div>
            <PayloadFilterRulesEditor
              value={values.payloadFilterRules}
              disabled={disabled}
              onChange={(payloadFilterRules) => onChange({ payloadFilterRules })}
            />
          </div>
        </div>
      </ConfigSection>
    </div>
  );
}
