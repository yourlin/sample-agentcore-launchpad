import { useTranslation } from "react-i18next";

import { type AgentForm, type AgentMethod, emptyAgentForm, formFromStoredSpec } from "../../../lib/agent-spec";
import { api, type AgentTemplateInfo, type SharedTemplateInfo, type Toolkit } from "../../../lib/api";
import { useLoad } from "../../hooks";
import { Card, OptionCard, Spin, Tag } from "../../ui";

/**
 * T10 — the scenario-template gallery on the wizard's first step.
 *
 * A template is a set of wizard defaults, not a resource: picking one fills the
 * form (method, prompt, whether documents are expected, demo toolkit, memory, the
 * T12 PII preset) and hands the member the ordinary configure step, where every
 * field is still editable. The catalogue itself is static backend data
 * (`GET /api/agent-templates`), so the copy lives in i18n and the shape in one place.
 */

/** The form a template produces, on top of the empty form for its method. */
export function formFromTemplate(template: AgentTemplateInfo): AgentForm {
  const form = emptyAgentForm(template.method);
  return {
    ...form,
    systemPrompt: template.system_prompt,
    toolkits: template.toolkits as Toolkit[],
    longTerm: template.memory_long_term,
    guardrail: template.guardrail ? "anonymize" : "off",
  };
}

export function TemplateGallery({
  onPick,
}: {
  onPick: (template: AgentTemplateInfo) => void;
}) {
  const { t } = useTranslation();
  // A failed read must not block the wizard: the member can still pick a method.
  const templates = useLoad(() => api.agentTemplates(), "agent-templates");
  const rows = templates.data?.templates ?? [];
  if (templates.loading) {
    return (
      <Card title={t("templates.title")} sub={t("templates.sub")}>
        <Spin />
      </Card>
    );
  }
  if (rows.length === 0) return null;
  return (
    <Card title={t("templates.title")} sub={t("templates.sub")} testId="v2-agent-templates">
      <div className="v2-options">
        {rows.map((template) => (
          <OptionCard
            key={template.key}
            title={t(template.label_key)}
            desc={t(template.description_key)}
            on={false}
            onClick={() => onPick(template)}
            badge={
              template.knowledge === "required" ? (
                <Tag tone="blue">{t("templates.needsDocs")}</Tag>
              ) : template.guardrail ? (
                <Tag>{t("templates.piiOn")}</Tag>
              ) : undefined
            }
            testId={`v2-agent-template-${template.key}`}
          />
        ))}
      </div>
    </Card>
  );
}

/**
 * T38 — the form a *shared* template produces.
 *
 * A shared template's spec is already pruned server-side (no environment ids, nothing
 * secret-shaped), so it is loaded through the same stored-spec reader an edit uses —
 * one mapping, not a second one to drift. Name and display name stay empty on purpose:
 * the consumer is creating their own agent, not a copy that impersonates the source.
 */
export function formFromSharedTemplate(template: SharedTemplateInfo): AgentForm {
  const method = (isAgentMethod(template.method) ? template.method : "harness") as AgentMethod;
  const { form } = formFromStoredSpec(method, "", template.spec);
  return { ...form, name: "", displayName: "" };
}

const AGENT_METHODS: AgentMethod[] = ["harness", "zip_runtime", "container", "byoc"];
function isAgentMethod(value: string): value is AgentMethod {
  return (AGENT_METHODS as string[]).includes(value);
}
