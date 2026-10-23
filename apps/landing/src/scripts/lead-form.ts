import {
  CONSENT_VERSION,
  UTM_KEYS,
  validateLeadSubmission,
  type LeadSubmission,
  type LeadResponse,
  type InterestedPlan,
} from "@whiteoven/contracts";
import { track } from "./analytics";
const form = document.querySelector<HTMLFormElement>("#interest-form");
if (form) {
  const fields = form.querySelector<HTMLFieldSetElement>(".lead-fields")!;
  const submit = form.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  const result = form.querySelector<HTMLElement>("#form-result")!;
  const availability = document.querySelector<HTMLElement>(
    "#availability-status",
  )!;
  const plan = form.querySelector<HTMLSelectElement>("#plan")!;
  const funnel = { pizzaBuilderInteracted: false, planCtaClicked: false };
  let busy = false;
  let available = false;
  let started = false;
  let lastBody = "";
  let key = "";
  const attribution: LeadSubmission["attribution"] = {
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    referrer: null,
    landingPath: "/",
  };
  const params = new URLSearchParams(location.search);
  for (const name of UTM_KEYS)
    attribution[name] =
      params
        .get(name)
        ?.slice(0, 100)
        // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted data.
        .replace(/[\u0000-\u001f\u007f<>]/gu, "") || null;
  try {
    if (document.referrer)
      attribution.referrer = new URL(document.referrer).origin;
  } catch {
    /* No referrer. */
  }
  track("landing_view");
  document.querySelector("[data-builder]")?.addEventListener("change", () => {
    funnel.pizzaBuilderInteracted = true;
    track("pizza_builder_interaction");
  });
  const pricing = document.querySelector("#planos");
  if (pricing) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          track("pricing_view");
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(pricing);
  }
  document.querySelectorAll<HTMLAnchorElement>("a[data-plan]").forEach((link) =>
    link.addEventListener("click", () => {
      const selected = link.dataset.plan?.toUpperCase();
      if (selected === "FLEX" || selected === "PRO") {
        if (!busy) plan.value = selected;
        funnel.planCtaClicked = true;
        track("plan_interest_click", selected);
        document.querySelector("#plan-status")!.textContent =
          `Plano ${selected === "FLEX" ? "Flex" : "Pro"} selecionado.`;
      }
    }),
  );
  form.addEventListener("input", () => {
    if (!started) {
      started = true;
      track("lead_form_started");
    }
  });
  const clearErrors = () => {
    delete result.dataset.state;
    form.querySelectorAll("[aria-invalid]").forEach((input) => {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    });
    form
      .querySelectorAll("[data-field-error]")
      .forEach((error) => error.remove());
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !available) return;
    clearErrors();
    const data = new FormData(form);
    const parsed = validateLeadSubmission({
      responsibleName: data.get("responsibleName"),
      pizzeriaName: data.get("pizzeriaName"),
      whatsapp: data.get("whatsapp"),
      monthlyOrderVolume: data.get("monthlyOrderVolume"),
      interestedPlan: data.get("interestedPlan"),
      contactConsent: data.get("contactConsent") === "on",
      consentVersion: CONSENT_VERSION,
      attribution,
      funnel,
      website: data.get("website"),
    });
    if (!parsed.valid) {
      for (const [name, message] of Object.entries(parsed.fields)) {
        const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
        const error = document.createElement("span");
        error.id = `error-${name}`;
        error.dataset.fieldError = "";
        error.className = "small";
        error.textContent = message;
        input.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-describedby", error.id);
        input.closest("label")!.append(error);
      }
      result.dataset.state = "error";
      result.textContent = "Revise os campos indicados antes de enviar.";
      form.querySelector<HTMLElement>("[aria-invalid]")?.focus();
      return;
    }
    const body = JSON.stringify(parsed.value);
    if (body !== lastBody || !key) {
      key = crypto.randomUUID();
      lastBody = body;
    }
    busy = true;
    fields.disabled = true;
    form.setAttribute("aria-busy", "true");
    submit.textContent = "Enviando…";
    result.textContent = "Registrando seu interesse…";
    track("lead_form_submitted", parsed.value.interestedPlan);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body,
        signal: controller.signal,
      });
      const reply = (await response.json()) as LeadResponse;
      if (!response.ok || !reply.ok) {
        if (!reply.ok && reply.code === "IDEMPOTENCY_CONFLICT") key = "";
        throw new Error(
          !reply.ok
            ? reply.message
            : "Não foi possível confirmar o cadastro. Tente novamente.",
        );
      }
      result.dataset.state = "success";
      result.textContent =
        "Interesse registrado! Nossa equipe poderá entrar em contato pelo WhatsApp informado.";
      track("lead_form_success", plan.value as InterestedPlan);
      form.reset();
      lastBody = "";
      key = "";
      started = false;
    } catch (error) {
      result.dataset.state = "error";
      result.textContent =
        error instanceof Error && error.name !== "AbortError"
          ? error.message
          : "Não foi possível confirmar o envio. Seus campos foram mantidos; tente novamente.";
      track("lead_form_error", plan.value as InterestedPlan);
    } finally {
      clearTimeout(timeout);
      busy = false;
      fields.disabled = false;
      form.removeAttribute("aria-busy");
      submit.textContent = "Registrar meu interesse";
      result.focus();
    }
  });
  async function checkAvailability() {
    try {
      const response = await fetch("/api/leads", { cache: "no-store" });
      const data = await response.json();
      available =
        response.ok &&
        data.available === true &&
        data.consentVersion === CONSENT_VERSION;
    } catch {
      available = false;
    }
    fields.disabled = !available;
    submit.disabled = !available;
    availability.textContent = available
      ? "Inscrições abertas. O envio registra seus dados para contato sobre o WhiteOven."
      : "Inscrições temporariamente indisponíveis. Tente recarregar a página mais tarde.";
  }
  void checkAvailability();
}
