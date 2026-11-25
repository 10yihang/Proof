import { useEffect, useId, useState, type FormEvent } from "react";
import {
  ArrowClockwise,
  CaretDown,
  Check,
  CircleNotch,
  FileCode,
  Plus,
  X,
} from "@phosphor-icons/react";
import { asError, useReadRequest, useRequest } from "../api";
import { t, uiMessage } from "../i18n";
import { comparisonRangeLabel } from "../diff-reading";
import { ocrFileReason } from "../ocr-labels";
import { Button, Input, Switch, Textarea } from "./ui/controls";
import type { OcrComparison } from "./OcrSettings";
import type { Side } from "../types";

type Rule = {
  path: string;
  rule: string;
  merge_system_rule?: boolean | null;
};

type Rules = {
  include?: string[] | null;
  exclude?: string[] | null;
  rules?: Rule[] | null;
};

interface SavedRules {
  fingerprint: string;
  content: string;
}

interface PreviewFile {
  path: string;
  willReview: boolean;
  excludeReason?: string;
}

interface RuleMatch {
  source: string;
  pattern: string | null;
  rule: string;
}

function parseRules(content: string): Rules | null {
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    for (const field of [value.include, value.exclude]) {
      if (
        field != null &&
        (!Array.isArray(field) ||
          field.some((path) => typeof path !== "string"))
      )
        return null;
    }
    const rules = value.rules;
    if (
      rules != null &&
      (!Array.isArray(rules) ||
        rules.some(
          (entry) =>
            typeof entry?.path !== "string" ||
            typeof entry?.rule !== "string" ||
            (entry.merge_system_rule != null &&
              typeof entry.merge_system_rule !== "boolean"),
        ))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function OcrRuleSettings({
  workspaceId,
  workspaceName,
  trusted = true,
  comparison,
  side,
  active,
}: {
  workspaceId?: string;
  workspaceName?: string;
  trusted?: boolean;
  comparison?: OcrComparison;
  side?: Side;
  active: boolean;
}) {
  const request = useRequest();
  const [saved, setSaved] = useState<SavedRules | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revision, reload] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const global = workspaceId === undefined;
  const ruleLabel = global ? t("OCR 全局规则") : t("OCR 仓库规则");

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    setMessage("");
    void request<SavedRules>(global ? "ocr_global_rules" : "ocr_rules", {
      workspaceId,
    })
      .then((rules) => {
        if (!current) return;
        setSaved(rules);
        setDraft(rules.content);
      })
      .catch((cause) => {
        if (current) setError(uiMessage(asError(cause).message));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [request, global, workspaceId, revision]);

  const parsed = parseRules(draft);
  const dirty = saved !== null && draft !== saved.content;
  const valid =
    parsed !== null && (parsed.rules ?? []).every((rule) => !!rule.path.trim());

  async function save() {
    if (!saved || !valid || !trusted) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const next = await request<SavedRules>(
        global ? "set_ocr_global_rules" : "set_ocr_rules",
        {
          workspaceId,
          content: draft,
          expectedFingerprint: saved.fingerprint,
        },
      );
      setSaved(next);
      setDraft(next.content);
      setMessage(global ? t("OCR 全局规则已保存") : t("OCR 仓库规则已保存"));
    } catch (cause) {
      const failure = asError(cause);
      setError(
        failure.code === "STALE_CONTENT"
          ? t("规则文件已更新，请重新读取后保存。")
          : uiMessage(failure.message),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="ocr-section-heading">
        <div className="ocr-rule-origin">
          {workspaceName && <h3>{workspaceName}</h3>}
          <div className="ocr-rule-location">
            <code>
              {global
                ? "~/.opencodereview/rule.json"
                : ".opencodereview/rule.json"}
            </code>
            {saved?.fingerprint === "" && <span>{t("未创建")}</span>}
          </div>
        </div>
        <div className="ocr-settings-actions">
          <Button
            className="icon-button"
            title={global ? t("重新读取全局规则") : t("重新读取仓库规则")}
            disabled={loading || saving}
            onClick={() => reload((value) => value + 1)}
          >
            <ArrowClockwise size={16} aria-hidden="true" />
          </Button>
          <Button
            className="button primary compact"
            disabled={loading || saving || !trusted || !dirty || !valid}
            onClick={() => void save()}
          >
            {saving
              ? t("正在保存…")
              : global
                ? t("保存全局规则")
                : t("保存仓库规则")}
          </Button>
        </div>
      </div>
      {loading && !saved && (
        <p role="status" className="ocr-inline-status">
          <CircleNotch size={15} className="spinning" aria-hidden="true" />
          {global ? t("正在读取全局规则") : t("正在读取仓库规则")}
        </p>
      )}
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="ocr-inline-status" role="status">
          <Check size={15} aria-hidden="true" />
          {message}
        </p>
      )}
      {saved && (
        <>
          <OcrRuleEditor
            key={revision}
            parsed={parsed}
            content={draft}
            label={ruleLabel}
            disabled={loading || saving || !trusted}
            onChange={(content) => {
              setDraft(content);
              setMessage("");
              setError("");
            }}
          />
          {!trusted && <p className="muted">{t("请先信任此仓库。")}</p>}
          {workspaceId && trusted && valid && (
            <OcrScopePreview
              active={active && !saving && !loading}
              workspaceId={workspaceId}
              comparison={comparison}
              side={side}
              rules={dirty ? draft : null}
            />
          )}
        </>
      )}
    </>
  );
}

function PatternEditor({
  label,
  values,
  disabled,
  placeholder,
  onChange,
}: {
  label: string;
  values: string[];
  disabled: boolean;
  placeholder: string;
  onChange: (values: string[]) => void;
}) {
  const [entry, setEntry] = useState("");
  function add(event: FormEvent) {
    event.preventDefault();
    const pattern = entry.trim();
    if (pattern && !values.includes(pattern)) {
      onChange([...values, pattern]);
      setEntry("");
    }
  }

  return (
    <div className="ocr-pattern-editor" role="group" aria-label={label}>
      <h4>{label}</h4>
      {values.map((pattern, index) => (
        <div className="ocr-pattern-row" key={index}>
          <Input
            className="ocr-pattern"
            value={pattern}
            aria-label={label}
            spellCheck={false}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                values.map((value, row) =>
                  row === index ? event.target.value : value,
                ),
              )
            }
          />
          <Button
            className="icon-button"
            title={t("移除路径规则")}
            disabled={disabled}
            onClick={() => onChange(values.filter((_, row) => row !== index))}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      ))}
      <form className="ocr-pattern-row" onSubmit={add}>
        <Input
          className="ocr-pattern"
          aria-label={t("添加路径模式")}
          placeholder={placeholder}
          value={entry}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => setEntry(event.target.value)}
        />
        <Button
          type="submit"
          className="icon-button"
          title={t("添加路径模式")}
          disabled={disabled || !entry.trim() || values.includes(entry.trim())}
        >
          <Plus size={15} aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}

function OcrRuleEditor({
  parsed,
  content,
  label,
  disabled,
  onChange,
}: {
  parsed: Rules | null;
  content: string;
  label: string;
  disabled: boolean;
  onChange: (content: string) => void;
}) {
  const [raw, setRaw] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const groupId = useId();
  const rules = parsed?.rules ?? [];
  const showJson = raw || !parsed;

  function update(patch: Partial<Rules>) {
    if (parsed)
      onChange(JSON.stringify({ ...parsed, ...patch }, null, 2) + "\n");
  }

  return (
    <div className="ocr-rule-editor">
      {showJson ? (
        <>
          <div className="ocr-section-heading">
            <h4>JSON</h4>
            <Button
              className="text-button"
              disabled={!parsed}
              onClick={() => setRaw(false)}
            >
              {t("返回表单")}
            </Button>
          </div>
          <Textarea
            className="ocr-rules-editor"
            aria-label={label}
            rows={8}
            value={content}
            disabled={disabled}
            spellCheck={false}
            aria-invalid={!parsed}
            onChange={(event) => {
              setRaw(true);
              onChange(event.target.value);
            }}
          />
        </>
      ) : (
        <>
          <div className="ocr-settings-fields">
            <PatternEditor
              label={t("纳入路径")}
              disabled={disabled}
              placeholder="src/**"
              values={parsed.include ?? []}
              onChange={(include) => update({ include })}
            />
            <PatternEditor
              label={t("排除路径")}
              disabled={disabled}
              placeholder="**/*.test.ts"
              values={parsed.exclude ?? []}
              onChange={(exclude) => update({ exclude })}
            />
          </div>
          <section className="ocr-instructions">
            <div className="ocr-section-heading">
              <h4>{t("审查指令")}</h4>
              <div className="ocr-settings-actions">
                <Button className="text-button" onClick={() => setRaw(true)}>
                  {t("编辑 JSON")}
                </Button>
                <Button
                  className={
                    rules.length ? "icon-button" : "text-button ocr-action"
                  }
                  title={t("添加审查规则")}
                  disabled={disabled}
                  onClick={() => {
                    setExpanded(rules.length);
                    update({ rules: [...rules, { path: "", rule: "" }] });
                  }}
                >
                  <Plus size={16} aria-hidden="true" />
                  {!rules.length && t("添加审查规则")}
                </Button>
              </div>
            </div>
            {rules.map((rule, index) => {
              const open = expanded === index;
              const id = groupId + "-" + index;
              const edit = (change: Partial<Rule>) =>
                update({
                  rules: rules.map((entry, row) =>
                    row === index ? { ...entry, ...change } : entry,
                  ),
                });
              return (
                <div key={index} className="ocr-instruction">
                  <div className="ocr-instruction-row">
                    <Button
                      className="ocr-instruction-toggle"
                      aria-expanded={open}
                      aria-controls={id}
                      onClick={() => setExpanded(open ? null : index)}
                    >
                      <CaretDown size={14} aria-hidden="true" />
                      <span className="ocr-pattern">
                        {rule.path || t("新规则")}
                      </span>
                    </Button>
                    <Button
                      className="icon-button"
                      title={t("移除审查规则")}
                      disabled={disabled}
                      onClick={() => {
                        setExpanded(null);
                        update({
                          rules: rules.filter((_, row) => row !== index),
                        });
                      }}
                    >
                      <X size={14} aria-hidden="true" />
                    </Button>
                  </div>
                  {open && (
                    <div id={id} className="ocr-instruction-fields">
                      <label className="ocr-settings-field">
                        <span>{t("匹配路径")}</span>
                        <Input
                          className="ocr-pattern"
                          value={rule.path}
                          placeholder="src/**/*.ts"
                          spellCheck={false}
                          disabled={disabled}
                          onChange={(event) =>
                            edit({ path: event.target.value })
                          }
                        />
                      </label>
                      <label className="ocr-settings-field">
                        <span>{t("审查指令")}</span>
                        <Textarea
                          rows={2}
                          value={rule.rule}
                          disabled={disabled}
                          onChange={(event) =>
                            edit({ rule: event.target.value })
                          }
                        />
                      </label>
                      <label className="ocr-merge-rule">
                        <span>{t("合并内置规则")}</span>
                        <Switch
                          checked={rule.merge_system_rule === true}
                          disabled={disabled}
                          onChange={(event) =>
                            edit({ merge_system_rule: event.target.checked })
                          }
                        />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}

const builtinExamples = [
  ["TypeScript", "src/index.ts"],
  ["Go", "main.go"],
  ["Python", "main.py"],
  ["Java", "Main.java"],
  ["Rust", "src/main.rs"],
  ["C++", "main.cpp"],
  ["SQL", "schema.sql"],
  ["YAML", "config.yaml"],
] as const;

export function OcrBuiltinRules({ active }: { active: boolean }) {
  const reader = useReadRequest();
  const [path, setPath] = useState<string>(builtinExamples[0][1]);
  const [query, setQuery] = useState({ path });
  const [match, setMatch] = useState<RuleMatch | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    let current = true;
    setMatch(null);
    setError("");
    void reader
      .read<RuleMatch>("ocr_builtin_rule", query)
      .then((result) => {
        if (current) setMatch(result);
      })
      .catch((cause) => {
        if (current) setError(uiMessage(asError(cause).message));
      });
    return () => {
      current = false;
      reader.cancel();
    };
  }, [active, query, reader]);

  return (
    <>
      <div
        className="ocr-segmented"
        role="group"
        aria-label={t("常用文件类型")}
      >
        {builtinExamples.map(([label, example]) => (
          <Button
            key={example}
            aria-pressed={query.path === example}
            onClick={() => {
              setPath(example);
              setQuery({ path: example });
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <form
        className="ocr-rule-lookup"
        onSubmit={(event) => {
          event.preventDefault();
          if (path.trim()) setQuery({ path: path.trim() });
        }}
      >
        <label className="ocr-settings-field">
          <span>{t("按文件路径查看")}</span>
          <Input
            className="ocr-pattern"
            value={path}
            spellCheck={false}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <Button type="submit" className="button" disabled={!path.trim()}>
          {t("查看规则")}
        </Button>
      </form>
      {error ? (
        <p className="ai-error" role="alert">
          {error}
        </p>
      ) : match ? (
        <OcrRuleDetails match={match} />
      ) : (
        <p className="ocr-inline-status" role="status">
          {t("正在匹配规则")}
        </p>
      )}
    </>
  );
}

function OcrRuleDetails({
  match,
  savedOnly,
}: {
  match: RuleMatch;
  savedOnly?: boolean;
}) {
  const sourceLabels: Record<string, string> = {
    project: t("仓库规则"),
    global: t("全局规则"),
    system: t("内置规则"),
    custom: t("本次规则"),
  };
  return (
    <div className="ocr-rule-match">
      <div className="ocr-rule-match-summary">
        <strong>{sourceLabels[match.source] ?? match.source}</strong>
        {match.pattern === "default" ? (
          <span>{t("通用规则")}</span>
        ) : match.pattern ? (
          <code>{match.pattern}</code>
        ) : null}
        {savedOnly && <span className="muted">{t("已保存规则")}</span>}
      </div>
      {match.rule && (
        <pre className="ocr-rule-text" tabIndex={0}>
          {match.rule}
        </pre>
      )}
    </div>
  );
}

function OcrScopePreview({
  active,
  workspaceId,
  comparison,
  side,
  rules,
}: {
  active: boolean;
  workspaceId: string;
  comparison?: OcrComparison;
  side?: Side;
  rules: string | null;
}) {
  const reader = useReadRequest();
  const matcher = useReadRequest();
  const [files, setFiles] = useState<PreviewFile[] | null>(null);
  const [filter, setFilter] = useState<"all" | "included" | "excluded">("all");
  const [pending, setPending] = useState(true);
  const [revision, refresh] = useState(0);
  const [path, setPath] = useState<string | null>(null);
  const [match, setMatch] = useState<RuleMatch | null>(null);
  const [error, setError] = useState("");
  const [matchError, setMatchError] = useState("");

  useEffect(() => {
    if (!active) return;
    let current = true;
    setPending(true);
    setFiles(null);
    setError("");
    setPath(null);
    const timer = window.setTimeout(() => {
      void reader
        .read<{ files: PreviewFile[] }>("ocr_preview", {
          workspaceId,
          rules,
          comparison,
          side,
        })
        .then((result) => {
          if (current) setFiles(result.files);
        })
        .catch((cause) => {
          if (current) setError(uiMessage(asError(cause).message));
        })
        .finally(() => {
          if (current) setPending(false);
        });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
      reader.cancel();
    };
  }, [active, reader, workspaceId, rules, comparison, side, revision]);

  useEffect(() => {
    if (!active || !path) return;
    let current = true;
    setMatch(null);
    setMatchError("");
    void matcher
      .read<RuleMatch>("ocr_rule_match", {
        workspaceId,
        comparison,
        side,
        path,
      })
      .then((result) => {
        if (current) setMatch(result);
      })
      .catch((cause) => {
        if (current) setMatchError(uiMessage(asError(cause).message));
      });
    return () => {
      current = false;
      matcher.cancel();
    };
  }, [active, path, matcher, workspaceId, comparison, side]);

  const included = files?.filter((file) => file.willReview).length ?? 0;
  const total = files?.length ?? 0;
  const visible =
    files?.filter(
      (file) => filter === "all" || file.willReview === (filter === "included"),
    ) ?? [];
  return (
    <section className="ocr-preview" aria-label={t("文件范围")}>
      <div className="ocr-section-heading">
        <h4>{t("文件范围")}</h4>
        <div className="ocr-settings-actions">
          {comparison && (
            <code title={`${comparison.base} → ${comparison.target}`}>
              {comparisonRangeLabel(comparison.base, comparison.target)}
            </code>
          )}
          {!comparison && side && (
            <code>
              {t(side === "staged" ? "HEAD → Index" : "Index → 工作区")}
            </code>
          )}
          <Button
            className="icon-button"
            title={t("刷新文件范围")}
            disabled={pending}
            onClick={() => refresh((value) => value + 1)}
          >
            <ArrowClockwise size={15} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {pending && (
        <p className="ocr-inline-status" role="status">
          <CircleNotch size={15} className="spinning" aria-hidden="true" />
          {t("OCR 正在筛选审查文件")}
        </p>
      )}
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      {files && (
        <>
          <div
            className="ocr-segmented ocr-preview-filters"
            role="group"
            aria-label={t("筛选审查文件")}
          >
            {(
              [
                ["all", "All", total],
                ["included", "纳入审查", included],
                ["excluded", "跳过", total - included],
              ] as const
            ).map(([value, label, count]) => (
              <Button
                key={value}
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(value);
                  setPath(null);
                }}
              >
                {t(label)} <span>{count}</span>
              </Button>
            ))}
          </div>
          {visible.length ? (
            <ul className="ocr-preview-files">
              {visible.map((file, index) => (
                <li
                  key={file.path + ":" + index}
                  data-selected={path === file.path || undefined}
                >
                  {file.willReview ? (
                    <Button
                      className="ocr-preview-file"
                      aria-pressed={path === file.path}
                      onClick={() => {
                        setMatch(null);
                        setMatchError("");
                        setPath(path === file.path ? null : file.path);
                      }}
                    >
                      <FileCode size={14} aria-hidden="true" />
                      <code title={file.path}>{file.path}</code>
                    </Button>
                  ) : (
                    <span className="ocr-preview-file">
                      <FileCode size={14} aria-hidden="true" />
                      <code title={file.path}>{file.path}</code>
                    </span>
                  )}
                  <span
                    className={
                      file.willReview ? "ocr-preview-included" : "muted"
                    }
                  >
                    {file.willReview ? (
                      <>
                        <Check size={13} aria-hidden="true" />
                        {t("纳入审查")}
                      </>
                    ) : (
                      ocrFileReason(file.excludeReason)
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              {t(total ? "没有符合筛选的文件" : "当前范围没有变更文件。")}
            </p>
          )}
          {path &&
            (matchError ? (
              <p className="ai-error" role="alert">
                {matchError}
              </p>
            ) : match ? (
              <OcrRuleDetails match={match} savedOnly={rules !== null} />
            ) : (
              <p className="ocr-inline-status" role="status">
                {t("正在匹配规则")}
              </p>
            ))}
        </>
      )}
    </section>
  );
}
