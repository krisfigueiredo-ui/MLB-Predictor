/**
 * Browser driver (Playwright).
 *
 * Responsibilities: open the posting, find the application form, describe every
 * control so the planner can reason about it, execute the plan, and submit only
 * when explicitly told to.
 */

import { existsSync } from "node:fs";
import { chromium } from "playwright";

const MARKER = "data-jobagent-id";

/** Chromium builds to fall back on when Playwright's own download is missing. */
function fallbackExecutables() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_PATH,
    process.env.CHROME_PATH,
    "/opt/pw-browsers/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];
  return candidates.filter((path) => path && existsSync(path));
}

export async function launchBrowser({ headless = true, slowMo = 0 } = {}) {
  const launchOptions = { headless, slowMo };
  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    const executables = fallbackExecutables();
    if (executables.length === 0) {
      throw new Error(
        `could not start Chromium: ${error.message.split("\n")[0]}\n` +
        "Run `npx playwright install chromium` in job-agent/, or set PLAYWRIGHT_CHROMIUM_PATH to a Chrome binary."
      );
    }
    browser = await chromium.launch({ ...launchOptions, executablePath: executables[0] });
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  return { browser, context };
}

export async function openPosting(context, url, { timeout = 45000 } = {}) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await page.waitForTimeout(1500); // let client-rendered boards paint
  return page;
}

/** Click an "Apply" affordance if the form is behind one. Never fatal. */
export async function revealForm(page, adapter) {
  const hasFields = await page.locator("form input, form textarea, form select").count();
  if (hasFields > 3) return false;

  for (const selector of adapter.applyButtonSelectors || []) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 1000 })) {
        await locator.click({ timeout: 5000 });
        await page.waitForTimeout(2000);
        return true;
      }
    } catch {
      // selector unsupported or not present — try the next one
    }
  }
  return false;
}

/**
 * Describe every fillable control on the page.
 *
 * Runs in the page so it can walk the DOM for labels the way a person reads
 * them: explicit <label for>, wrapping label, aria-label(ledby), the group's
 * legend, then placeholder. Each control is tagged with a marker attribute so
 * actions can address it later without brittle CSS paths.
 */
export async function extractFields(page) {
  return page.evaluate((markerAttribute) => {
    const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

    function visible(element) {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0 || element.type === "file";
    }

    function textOf(node) {
      return (node?.textContent || "").replace(/\s+/g, " ").trim();
    }

    function labelFor(element) {
      if (element.id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (explicit) return textOf(explicit);
      }
      const wrapping = element.closest("label");
      if (wrapping) {
        const clone = wrapping.cloneNode(true);
        for (const control of clone.querySelectorAll("input, select, textarea")) control.remove();
        const text = textOf(clone);
        if (text) return text;
      }
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => textOf(document.getElementById(id)))
          .filter(Boolean)
          .join(" ");
        if (text) return text;
      }
      const fieldset = element.closest("fieldset");
      if (fieldset) {
        const legend = textOf(fieldset.querySelector("legend"));
        if (legend) return legend;
      }
      // Last resort: the nearest preceding text in the control's own container.
      const container = element.closest("div, li, td, p, section");
      if (container) {
        const clone = container.cloneNode(true);
        for (const control of clone.querySelectorAll("input, select, textarea, option")) control.remove();
        const text = textOf(clone);
        if (text && text.length < 200) return text;
      }
      return "";
    }

    function isRequired(element, label) {
      if (element.required || element.getAttribute("aria-required") === "true") return true;
      return /\*|\(required\)/i.test(label);
    }

    const elements = [...document.querySelectorAll("input, select, textarea")];
    const fields = [];
    const radioGroups = new Map();
    let counter = 0;

    for (const element of elements) {
      const tag = element.tagName.toLowerCase();
      const type = tag === "input" ? (element.type || "text").toLowerCase() : tag;
      if (tag === "input" && SKIP_TYPES.has(type)) continue;
      if (element.disabled || element.readOnly) continue;
      if (!visible(element) && type !== "file") continue;

      const marker = String(counter++);
      element.setAttribute(markerAttribute, marker);
      const label = labelFor(element);

      if (type === "radio") {
        const groupName = element.name || label;
        const optionLabel = textOf(element.closest("label")) || element.value || "";
        if (!radioGroups.has(groupName)) {
          const group = {
            marker,
            type: "radio",
            name: groupName,
            id: element.id || "",
            label: "",
            ariaLabel: element.getAttribute("aria-label") || "",
            placeholder: "",
            required: isRequired(element, label),
            options: [],
            optionMarkers: {}
          };
          radioGroups.set(groupName, group);
          fields.push(group);
        }
        const group = radioGroups.get(groupName);
        // The group's own question is the label shared by all its options.
        if (!group.label || (label && label.length > group.label.length && !label.includes(optionLabel))) {
          const fieldset = element.closest("fieldset");
          const legend = textOf(fieldset?.querySelector("legend"));
          group.label = legend || label;
        }
        if (optionLabel) {
          group.options.push(optionLabel);
          group.optionMarkers[optionLabel] = marker;
        }
        continue;
      }

      const field = {
        marker,
        type,
        name: element.name || "",
        id: element.id || "",
        label,
        ariaLabel: element.getAttribute("aria-label") || "",
        placeholder: element.getAttribute("placeholder") || "",
        required: isRequired(element, label)
      };

      if (type === "select") {
        field.options = [...element.querySelectorAll("option")]
          .map((option) => (option.textContent || "").trim())
          .filter((text) => text.length > 0 && !/^(select|choose|please select)/i.test(text));
      }
      fields.push(field);
    }

    return fields;
  }, MARKER);
}

function locatorFor(page, marker) {
  return page.locator(`[${MARKER}="${marker}"]`).first();
}

/** Execute one planned action. Returns `{ ok, error }` — failures never throw. */
export async function applyAction(page, step) {
  const { field, action, value } = step;
  try {
    if (action === "fill") {
      await locatorFor(page, field.marker).fill(String(value), { timeout: 10000 });
    } else if (action === "select") {
      await locatorFor(page, field.marker).selectOption({ label: String(value) }, { timeout: 10000 });
    } else if (action === "upload") {
      await locatorFor(page, field.marker).setInputFiles(String(value), { timeout: 20000 });
    } else if (action === "check") {
      if (field.type === "radio") {
        const marker = field.optionMarkers?.[value];
        if (!marker) return { ok: false, error: `no radio option "${value}"` };
        await locatorFor(page, marker).check({ timeout: 10000 });
      } else if (value) {
        await locatorFor(page, field.marker).check({ timeout: 10000 });
      } else {
        await locatorFor(page, field.marker).uncheck({ timeout: 10000 });
      }
    } else {
      return { ok: false, error: `unknown action: ${action}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message.split("\n")[0] };
  }
}

export async function screenshot(page, path) {
  await page.screenshot({ path, fullPage: true });
  return path;
}

export async function pageText(page) {
  return page.evaluate(() => document.body?.innerText?.slice(0, 20000) || "");
}

/** Click the submit control. Only ever called on an explicit --submit run. */
export async function submitForm(page, adapter, { timeout = 30000 } = {}) {
  for (const selector of adapter.submitSelectors || []) {
    try {
      const locator = page.locator(selector).first();
      if (!(await locator.isVisible({ timeout: 1500 }))) continue;
      if (!(await locator.isEnabled())) continue;
      await locator.click({ timeout: 10000 });
      await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
      await page.waitForTimeout(2500);
      return { ok: true, selector };
    } catch (error) {
      return { ok: false, error: error.message.split("\n")[0], selector };
    }
  }
  return { ok: false, error: "no visible submit button found" };
}

/**
 * Heuristic confirmation check after submitting: look for the phrases these
 * boards show on success, or for validation errors that mean it didn't go
 * through.
 */
export async function confirmSubmission(page) {
  const text = (await pageText(page)).toLowerCase();
  const success = [
    "thank you for applying",
    "application submitted",
    "thanks for applying",
    "we have received your application",
    "your application has been submitted",
    "application received"
  ].find((phrase) => text.includes(phrase));
  if (success) return { confirmed: true, evidence: success };

  const errorCount = await page
    .locator("[aria-invalid='true'], .error:visible, .field_with_errors, [class*='error-message']:visible")
    .count()
    .catch(() => 0);
  if (errorCount > 0) return { confirmed: false, evidence: `${errorCount} validation error(s) on the page` };

  return { confirmed: false, evidence: "no confirmation text found" };
}
