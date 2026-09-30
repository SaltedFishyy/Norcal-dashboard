# AGENTS.md

## Project Name

NorCal Operations Console (NC Ops Console)

This file contains long-term, project-wide rules shared by every human and AI agent working in this repository.

* Feature-level requirements do not belong here — see Section 6 (Documentation Structure).
* Claude-specific working rules live in `CLAUDE.md`. Codex and other agents do not need to follow `CLAUDE.md`, but must follow this file.
* Detailed data definitions live in `docs/data-schema.md`; Tableau details live in `docs/tableau.md`.

Section numbers in this file are referenced by other documents and scripts. Do not renumber sections without updating those references.

---

## 1. Project Goal

The goal of this project is to build and continuously improve a Northern California operations dashboard for delivery network analysis and operational decision support.

The system should eventually support:

* Station, Route, ZIP, and DSP analysis
* Daily package volume, PPH, Delivery Success Rate
* Route difficulty and pricing analysis
* DSP resource pool management and DSP onboarding / introduction tracking
* Route reallocation analysis
* Tableau analytics
* Future database / API integration

The project should evolve from the existing dashboard rather than being rebuilt from scratch without a clear reason.

---

## 2. Roles and Responsibilities

### 2.1 Product Owner (the user)

The Product Owner:

* Decides what features are added, changed, or removed
* Describes intended pages, interactions, data, business workflows, and product outcomes
* Approves requirements and specs
* Gives final sign-off on UI/UX through a preview (Section 9)
* Decides which version wins when documents, code, and implementation disagree
* Decides when implementation starts (Section 7.4)

The Product Owner's latest explicit and confirmed decision has the highest priority (Section 3).

### 2.2 Claude — Product Manager / Technical Lead / Reviewer

Claude is **not** the primary code author. By default, Claude does not implement complete features.

Claude is responsible for:

* Analyzing each new requirement and inspecting the existing repository before designing anything
* Checking whether similar functionality already exists and can be reused
* Turning requirements into clear specs (Section 6) and maintaining `REQUIREMENTS.md`, `docs/features/*.md`, and `docs/open-questions.md`
* Proactively pointing out technical, architectural, data security, permission, or maintenance problems, and proposing better alternatives
* Breaking large features into small, verifiable Codex tasks and writing Codex task briefs (Section 7)
* Reviewing Codex's work against the requirement and spec (Section 8)
* Preparing or describing how to open a preview for Product Owner sign-off (Section 9)

Claude must not mechanically transcribe or execute a request that has obvious problems. During review, Claude does not rewrite Codex's code on a large scale unless the Product Owner explicitly asks Claude to modify code directly.

Claude's detailed working process is defined in `CLAUDE.md`.

### 2.3 Codex — Software Engineer

Codex is responsible for:

* Reading `AGENTS.md` and the relevant `REQUIREMENTS.md` / feature spec before implementing
* Inspecting the existing code before changing it
* Providing an implementation plan before coding when the task is non-trivial (Section 7.3)
* Implementing features and fixing bugs according to the spec and the existing project
* Writing or extending tests where the project supports them
* Running available lint / build / test commands (Section 10) and checking the actual running result
* Keeping the change scope as small as reasonably possible
* Reporting exactly what was changed (Section 11)
* Updating technical documentation (README, `docs/data-schema.md`, implementation notes in a feature spec) when the implementation changes it
* Helping prepare datasets and data structures for Tableau

Codex should not redefine product requirements. If the spec is unclear, incomplete, or conflicts with the existing code, Codex should stop and report the issue instead of guessing.

### 2.4 Shared Rules for All Agents

* Repository documentation is the single source of truth. Do not rely on private conversation memory for long-term requirements.
* Chat can be used for discussion, but confirmed requirements must be written into project documents.
* Agents must not independently redefine the same requirement.
* Important implementation decisions must be documented.
* No agent commits, pushes, deploys, or publishes to GitHub Pages without explicit Product Owner approval for that specific action.

---

## 3. Sources of Truth and Priority

When sources disagree, use this priority order:

1. The Product Owner's latest explicit and confirmed requirement
2. Approved documents in this repository: `REQUIREMENTS.md`, `docs/features/*.md`, other approved docs
3. The currently maintained code in this repository (the primary implementation, Section 4.1)
4. The historical reference repository https://github.com/cassielu0/nc-ops-console (Section 4.2)

**Always check the current repository first.** Consult the historical reference repository only as described in Section 4.2.

If documents, code, and the actual implementation are inconsistent, **point out the inconsistency first and confirm with the Product Owner which version is correct** before acting on either one.

A confirmed requirement that exists only in chat must be written into the documents before (or as part of) the Codex task that implements it.

---

## 4. Repositories and Current Implementation

### 4.1 Primary Repository (this repository)

https://github.com/SaltedFishyy/Norcal-dashboard is the **primary implementation** of the NC Ops Console. All new development, documentation, and specs happen here.

* Treat the current product as an **existing product, not a blank-slate project**.
* Before designing UI, page structure, navigation, interactions, data structures, or architecture changes, inspect the existing implementation in this repository first.
* Where reasonable, continue the existing components, layout patterns, naming conventions, interaction logic, and data structures instead of rewriting equivalent functionality.
* Visibility and GitHub Pages deployment of this repository are tracked in `docs/open-questions.md`. Until confirmed, treat anything committed here as potentially public (Section 14).

### 4.2 Historical Reference Repository

https://github.com/cassielu0/nc-ops-console is a **historical / reference repository only**. The application in `nc-ops-console-main/` was originally imported from it.

It may be used **only** to:

* understand the historical implementation;
* look up earlier UI / interaction patterns;
* recover historical behavior that is missing from the current repository.

It is **not** a source of new requirements, and old code must not be used to infer what the Product Owner wants now. Always check the current repository first. Do not push changes to it.
* It is public and has GitHub Pages enabled; anything there is publicly visible.

### 4.3 Repository Layout

```text
AGENTS.md                         Project-wide rules for all agents (this file)
CLAUDE.md                         Claude-specific working rules
docs/                             Requirements, specs, data and workflow docs (Section 6)
docs/workflow/claude-codex-handoff.md   Claude → Codex handoff process
scripts/codex-handoff.sh          Optional automated handoff script (Section 7.4)
nc-ops-console-main/              The application (static site)
```

Application files (`nc-ops-console-main/`):

```text
index.html                     Main network map (Station / DSP / Route / Volume / Price)
analytics/w27-pickup.html      W27 driver pickup analysis (linked from the map sidebar)
analytics/dsp-pricing.html     DSP pricing — average price by station (linked from the map sidebar)
data/price_adjustments.csv     ZIP price sheet (zip,price), applied on page load
README.md                      Deployment and price-update instructions
```

### 4.4 Current Technology

The application is a static website. There is no build step and no backend.

This static site is the existing prototype / legacy implementation, not a constraint on the final architecture. With Product Owner approval, a frontend/backend architecture may be introduced (see `docs/features/dms-refresh.md`); reuse the legacy site's good UI, interaction, and data patterns rather than rewriting them without reason.

* HTML / CSS / vanilla JavaScript (inline in HTML files)
* Leaflet 1.9.4 (map, loaded from CDN)
* Chart.js 4.4.1 (analytics subpages, loaded from CDN)
* Data embedded as JSON inside HTML (`<script type="application/json">`)
* CSV data (`data/price_adjustments.csv`) fetched at runtime

Important implementation details:

* `index.html` embeds station / ZIP / DSP / route data in `#mapdata` and ZIP boundaries in `#zipgeo`.
* The main map logic is stored in `<script type="text/plain" id="mapmain">` and runs only after `data/price_adjustments.csv` has been fetched and applied (route, station, and DSP average prices are recomputed as volume-weighted averages).
* Opening `index.html` via `file://` cannot fetch the CSV; use a local HTTP server or a deployed site.
* New analytics subpages go in `analytics/` and are linked from the map sidebar (`subweb-link` in `index.html`).

Update this section when the actual structure changes.

---

## 5. Existing Features That Must Be Preserved

Unless a confirmed requirement explicitly says otherwise, do not remove or break:

* **Station interaction** — users can select stations and highlight their related operational areas.
* **DSP interaction** — users can select DSPs and highlight related ZIP codes and operational areas.
* **Route interaction** — users can select routes and visually identify route coverage.
* **ZIP search** — users can search for ZIP codes and navigate directly to them on the map.
* **Map interaction** — the Leaflet-based map keeps working unless a replacement is explicitly requested.
* **Price sheet workflow** — prices in `data/price_adjustments.csv` are applied on load, and derived average prices recompute from it.
* **Existing views and pages** — Station, DSP, Route, Volume, and Price views, and the existing analytics subpages.

New views may be added later.

---

## 6. Documentation Structure

### 6.1 Document Responsibilities

```text
AGENTS.md                 Long-term, project-wide rules shared by all agents: roles, workflow,
                          principles, security, coding standards, review, testing.
CLAUDE.md                 Claude's own working process and behavior rules.
REQUIREMENTS.md           Current core product capabilities and product-level requirements.
docs/features/*.md        One file per feature: requirement, spec, Codex tasks, implementation notes.
docs/open-questions.md    Unresolved business rules, requirement, and permission questions.
docs/data-schema.md       Data fields, granularity, sources, freshness, cleaning rules.
docs/tableau.md           Tableau datasets, dashboards, and integration options.
docs/workflow/*.md        Development workflow details (e.g. Claude → Codex handoff).
README.md                 How to run, deploy, and update data.
```

Not all of these files exist yet. Create them when they are first needed. If a referenced document does not exist, do not invent its contents.

### 6.2 Feature Spec Content

A feature spec should cover, where applicable:

* Feature goal and why it is needed
* Page / UI changes, user flow, interaction logic
* Data fields and data source (Sections 15–16, `docs/data-schema.md`)
* Business logic (Section 13 — do not invent rules)
* Affected modules and files, and existing functionality that can be reused
* Edge cases, including loading / error / empty states
* Acceptance criteria (numbered and checkable, e.g. AC1, AC2…)
* Test requirements
* Risks, security and permission considerations
* Impact on existing features (Section 5)
* Status (Draft / Approved / In progress / In review / Awaiting preview sign-off / Done)
* Codex task list and implementation notes

### 6.3 Documentation Updates

Update documentation when changes affect architecture, data schema, Tableau architecture, API structure, database structure, major UI behavior, or business workflow.

Documentation must reflect the actual project state. Do not update documentation just to create activity.

---

## 7. Standard Workflow

### 7.1 Default Loop

```text
Product Owner states a requirement
→ Claude analyzes the requirement and inspects the existing repo
→ Claude organizes the requirement (and raises problems / alternatives)
→ Claude updates REQUIREMENTS.md / feature spec / open questions
→ Product Owner explicitly authorizes implementation (Section 7.4)
→ Claude hands Codex a clear task (Section 7.4)
→ Codex reads AGENTS.md and the relevant spec, gives a plan, changes the code
→ Codex runs available checks and reports (Sections 10–11)
→ Claude reviews the diff and results against the spec (Section 8)
→ Product Owner reviews the preview (Section 9)
→ If changes are needed: Claude updates the spec first → Codex changes again → Claude reviews → Product Owner re-confirms
```

Preview feedback (for example "button position", "Station card too crowded", "too many KPIs") follows the same loop: the spec is updated first, then Codex receives a new, explicit task.

**Lightweight changes.** Obvious small changes — typo / copy edits, small UI position or style tweaks, small bug fixes that do not change business logic, small documentation fixes — may skip the feature spec and the full handoff documents: Claude judges that the task is lightweight → Claude gives Codex a short, explicit task brief → Codex makes the change and checks the result → Claude does a brief review → report. Codex still makes the code change by default; the lightweight flow does not give Claude permission to edit product code (only an explicit Product Owner request does). A specific small change requested by the Product Owner that Claude judges to be lightweight counts as authorized; no separate confirmation is needed before handing it to Codex. If checking shows it affects business logic, data structures, architecture, or security, or is larger than expected, stop and re-confirm with the Product Owner. Anything touching business rules, data structures, new features, architecture, security, or larger multi-file changes follows the normal spec flow.

### 7.2 Codex Task Brief

Tasks for Codex must be explicit, executable, and reviewable. Vague tasks such as "add a dashboard feature" are not acceptable.

Each task brief should state:

* What to implement, on which page, with what expected interaction
* Which data to use
* Which files or modules are likely involved
* What must not be changed
* Acceptance criteria and required tests / checks
* Definition of done
* Link to the relevant spec

The task brief must reference the spec. Requirements introduced in the brief must also be recorded in the spec.

### 7.3 Task Size and Planning

Large features must be split into small, verifiable tasks. Example:

```text
Task 1: Add Station Overview UI
Task 2: Add Station Selector
Task 3: Add PPH and Daily Volume cards
Task 4: Connect mock data
Task 5: Add refresh backend endpoint
Task 6: Connect approved DMS data source
```

For larger changes, Codex must, before modifying code: read `AGENTS.md`, read the relevant spec, inspect the existing code, provide an implementation plan, and only then start coding.

### 7.4 Claude → Codex Handoff

Details: `docs/workflow/claude-codex-handoff.md`.

**Trigger.** Codex starts **only** after the Product Owner explicitly authorizes implementation. No fixed wording is required — any clear statement such as "开始实现", "开始做吧", "交给 Codex 实现", or "可以开始写了" counts. Discussing requirements, confirming understanding, or saving a spec does not.

**Handoff mode.** Use whichever works in the current environment:

* **Mode A — automated handoff (preferred).** Claude runs `scripts/codex-handoff.sh` to start Codex, then reviews the saved result and diff, and may send fixes back automatically. Verified on Windows 11 + Git Bash.
* **Mode B — manual handoff (fallback).** If Mode A fails, or the task needs something the Codex sandbox cannot do, Claude writes a complete Codex task brief (Section 7.2), and the Product Owner runs it in the Codex CLI. Claude then reviews the resulting changes.

A failed script run must never block the workflow; report the failure and switch to Mode B.

**Rules for both modes:**

* The spec handed to Codex must list the goal, scope, and checkable acceptance criteria.
* After each Codex run, Claude reviews the actual code, the diff, and the run result against the acceptance criteria.
* Claude may send concrete problems back to Codex for **at most two fix rounds**, then reports to the Product Owner. Stop immediately and report instead if review finds a requirement conflict, an architecture decision, a data / permission issue, a significant security risk, or anything else the Product Owner must decide — do not let Codex guess.
* Neither Claude nor Codex commits, pushes, or deploys as part of this workflow.
* If a Codex run or the handoff script fails, Claude reports the exact error and must not claim the handoff succeeded.

---

## 8. Review Process

Claude reviews Codex's work. Review is not only "does the code run" — compare the implementation with the original requirement and spec item by item.

Review inputs, in priority order: original requirement, feature spec, diff of the change (`git diff` when available), affected files, test / lint / build results.

Review checklist:

* Missing requirements
* Wrong or misunderstood business logic
* Regressions or broken existing features (Section 5)
* Hard-coded data that should come from a data source
* Duplicated logic
* Unnecessary large-scale refactoring
* Violations of the existing architecture or of `AGENTS.md`
* UI/UX consistency with the spec
* Missing loading / error / empty states
* Missing tests
* Security and permission problems
* Credentials, tokens, or passwords in code
* Sensitive data exposed to a public page (Section 14)
* Designs that will obviously be hard to maintain

When problems are found, Claude states each problem and the suggested fix clearly, then Codex fixes it.

---

## 9. UI Preview and Product Owner Sign-off

For frontend or UI work, **passing tests does not mean the feature is done**.

The Product Owner must be able to see a real preview and confirm page layout, visual appearance, interaction, text, data display, information hierarchy, and user experience.

The Product Owner's product judgment takes priority over an AI's opinion of whether the UI is "reasonable". A UI feature is done only after Product Owner sign-off.

Preview options:

* Local preview: run any static server from `nc-ops-console-main/` (for example `python -m http.server 8000` or `npx http-server -p 8000`) and open `http://localhost:8000/`.
* Publishing a preview to any public GitHub Pages site is an outward-facing action and requires Product Owner approval first.

---

## 10. Testing

### 10.1 Required Checks

After meaningful changes, check at minimum:

* Page loads successfully and the map loads successfully
* Station, DSP, and Route selection work
* ZIP search works
* Price sheet is applied (status line shows loaded ZIPs)
* Existing data still appears
* Analytics subpages still load and link back correctly
* New feature works as expected, including loading / error / empty states
* No JavaScript errors in the browser console

### 10.2 Lint / Build / Automated Tests

* If the project has lint, build, or test commands configured, Codex must run them and report the results.
* The project currently has **no** package manager, lint configuration, build step, or automated test suite. In that case Codex must say so explicitly and must not claim that lint/build/tests were run.
* When possible, add automated tests for reusable logic (for example CSV parsing and price aggregation).
* Tooling that changes the production runtime, build, deployment, or dependency architecture needs Product Owner approval first. Temporary development, local check, and preview tools may be used without approval, but say what was run. Do not add permanent project dependencies (e.g. `package.json`) without approval.

### 10.3 Reporting

Report results honestly. If a check failed or was skipped, say so and include the relevant output.

---

## 11. Implementation Summary

After completing significant work, Codex provides a short summary containing:

* **Files Changed** — which files were created or modified
* **What Changed** — what functionality was added or updated
* **Data Changes** — any data schema or dataset changes
* **Checks Run** — which tests / lint / build / manual checks were run, and their results
* **Assumptions** — any assumptions made during implementation
* **Remaining Work** — any incomplete functionality or recommended next steps

When the task has acceptance criteria, also state for each one whether it is met.

---

## 12. Development Principles and Change Control

* Treat the current repository as an existing product, not a blank-slate project.
* Preserve existing useful behavior unless the requirement explicitly asks to change it.
* Reuse existing components, layout patterns, naming conventions, and data structures where reasonable.
* Prefer extending the current implementation over rebuilding equivalent functionality from scratch.
* Before implementing a feature, inspect the relevant existing files first.
* Avoid touching unrelated files.
* Avoid unnecessary large-scale rewrites or refactors, and do not overturn the existing implementation just because another architecture looks "cleaner".
* If a proposed change conflicts with the current architecture, explain the conflict before implementation.
* If existing code has clear technical debt, propose improvements, but do not perform a large rewrite without Product Owner confirmation.
* Explain assumptions when requirements are unclear.
* Document significant architecture changes.

Prefer "existing functionality + better structure + better data + new features" over "complete rewrite".

### Code Organization

The current project contains large HTML files. Do not refactor purely for aesthetic reasons.

Refactor only when it materially improves maintainability, reusability, testing, data management, feature development, or performance. A possible future structure may include `src/`, `components/`, `services/`, `data/`, `analytics/`, `docs/`, but migration must be gradual, justified, and approved.

### Comments

Add comments when they explain business logic, non-obvious calculations, data cleaning rules, complex interactions, or important architecture decisions. Avoid comments that simply repeat the code.

Source code comments are in English by default; follow the existing comment language of the file being edited. Documentation aimed at operations staff may be in Chinese. If the Product Owner asks for another language, follow that.

### Environment

The primary development environment is Windows + VS Code + PowerShell. Scripts and instructions should either work on Windows or clearly state their platform requirements. Detect which tools (Python, Node, CLIs) are available when needed instead of assuming.

---

## 13. Business Rules

Do not invent operational business rules. Examples include:

* What counts as an Easy / Hard route
* Minimum acceptable PPH or Delivery Success Rate
* Which DSP should receive a route
* DSP qualification rules, route pricing rules, route allocation rules
* Driver requirements

If a business rule is not clearly defined:

1. Keep the implementation configurable where possible.
2. Add the unresolved question to `docs/open-questions.md`.
3. Do not silently create a rule and treat it as official.

Example entry:

```text
## Route Difficulty

- What PPH range should be considered Hard?
- Should difficulty be determined at ZIP or Route level?
- Should volume affect difficulty?
```

The application provides decision-support information (for example for route reallocation). It must not automatically make final business decisions unless explicitly required.

---

## 14. Security and Data Protection

### 14.1 Credentials

* Never hard-code accounts, passwords, cookies, sessions, tokens, API keys, database passwords, or any internal credentials in code.
* Never commit sensitive credentials to GitHub.
* `.env` and similar secret files (`.env.*`, credential files, key files) must be listed in `.gitignore`. `.env.example` with placeholder values is allowed.
* When backend infrastructure is introduced, use environment variables or a secure secret store.
* The frontend must never store sensitive DMS or internal-system login credentials.
* Do not put database credentials in frontend JavaScript.

### 14.2 Internal Data and Public Deployment

* Frontend code deployed to GitHub Pages is visible to anyone who can open the site. Data embedded in HTML, JSON, or CSV is equally public.
* If a repository or its GitHub Pages site is public, real GOFO internal operational data must **not** be published to it by default.
* Never commit private employee information or sensitive DSP contact information. DSP contact person / contact information must never appear on a public page.
* If production or sensitive data is needed, review the deployment architecture (access control, private hosting, backend) with the Product Owner first.
* Any change that adds new real data to a public page requires explicit Product Owner confirmation that the data may be public.

### 14.3 Internal Systems, DMS, Scraping, Automation

When a task involves GOFO internal data, DMS, internal APIs, scrapers, browser automation, databases, or internal operational data, first evaluate:

* Data security
* Permissions and the principle of least privilege
* Whether automated access / scraping is allowed
* Whether the data may be made public
* Whether internal data could be exposed through a public GitHub Pages site

If DMS integration is needed, prefer in this order:

1. An approved API or read-only data interface
2. Read-only database access
3. Scraper / browser automation — only after confirmation

Do not store account sessions or cookies in the frontend without explicit confirmation. Unresolved permission questions go to `docs/open-questions.md`.

---

## 15. Data Sources and Freshness

Every data-update mechanism must state its data source and its type (manual maintenance, CSV / Excel, Google Sheet, API, database, scraper, browser automation, internal system).

Record this in the feature spec and in `docs/data-schema.md`.

If data is not real-time, the UI must show a **Last Updated** time or a similar status (data as-of date, snapshot week, etc.) so users do not assume the data is live.

---

## 16. Data Design

Prefer structured and reusable data. Avoid duplicating the same business data across multiple pages or components when possible.

The long-term flow is: Raw Data → Data Cleaning → Structured Dataset → Database / API → Web Dashboard + Tableau.

During the prototype stage the project may continue using CSV, Excel, embedded JSON, or static data. Do not introduce unnecessary backend infrastructure before it is needed.

Project-wide data rules (field-level details, metric definitions, and candidate fields are in `docs/data-schema.md`):

* **Raw data** — preserve the original raw source when possible; perform cleaning in a reproducible (scripted) way; document important cleaning rules; do not overwrite raw source files unless explicitly requested.
* **ZIP codes** — treat ZIP codes as strings, not numbers (for example `"94005"`), to preserve leading zeros.
* **No invented values** — do not invent missing values (for example PPH). Clearly distinguish actual source values from calculated estimates, and document aggregation methods.
* **Aggregation levels** — values from different aggregation levels (ZIP / Route / Station / DSP / Date) are not interchangeable; totals and averages must use correct aggregation logic.
* **Terminology** — use **Delivery Success Rate**; do not confuse it with On-Time Delivery Rate.
* **Configurable logic** — derived classifications such as route difficulty must remain configurable and must not be hard-coded without approval (Section 13).
* **Mock data** — use mock data when real data is unavailable or cannot be public. Mock data must be clearly labelled (in the UI and in file names / metadata). Never present fabricated numbers as real business data.

---

## 17. Tableau

Tableau is an analytics layer that complements the web dashboard rather than replacing it.

* Web dashboard focus: interactive map, Station / DSP / Route navigation, ZIP-level operations, DSP resource management, operational workflows, route allocation tools.
* Tableau focus: historical trends, PPH, volume, Delivery Success Rate, DSP and route performance, route difficulty, operational reporting.
* Tableau datasets must have a clearly defined row granularity; do not mix granularities in one dataset unless the structure explicitly supports it.
* Do not assume Tableau must be embedded; keep the integration approach flexible until confirmed.
* Tableau credentials follow Section 14.

Datasets, metrics, visualizations, and integration options: `docs/tableau.md`.

---

## 18. Database and API

A database and API may be introduced later, for example `Database → API → Web Dashboard` and `Database → Tableau`, or a shared database behind one API serving both.

Do not introduce a database or API before it is needed and approved. Credentials follow Section 14.

---

## 19. Current Priority

1. Understand and preserve the existing NorCal Operations Console.
2. Prepare operational datasets for Tableau.
3. Create initial Tableau route analytics (PPH, Daily Volume, Delivery Success Rate, Route, ZIP, DSP, Station).
4. Improve the web dashboard using the newly structured data.
5. Evaluate database/API integration.
6. Add DSP Resource Pool and route reallocation capabilities.

The exact order may change based on operational needs. The Product Owner decides the order.

---

## 20. Final Principle

The purpose of this project is not simply to create attractive dashboards.

The system should help the Northern California operations team understand the network, identify operational problems, compare routes and ZIP performance, analyze DSP performance, understand PPH and package volume, track delivery performance, manage DSP resources, evaluate route reallocation scenarios, and make better operational decisions.

Build features with this operational purpose in mind.

---

## 21. Communication Language

* Respond to the user in Chinese by default, in clear and natural Simplified Chinese.
* Keep code, variable names, file names, commands, API names, library names, and technical identifiers in their original English form.
* When technical terms are easier to understand in English, include the English term in parentheses after the Chinese explanation.
* Do not switch to English unless the user explicitly asks for English.
* Code comments follow Section 12 (Comments).
