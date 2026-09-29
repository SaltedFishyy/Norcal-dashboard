# AGENTS.md

## Project Name

NorCal Operations Console (NC Ops Console)

This file contains long-term, project-wide rules for every human and AI agent working in this repository.
Feature-level requirements do not belong here — see Section 5 (Documentation Structure).

---

## 1. Project Goal

The goal of this project is to build and continuously improve a Northern California operations dashboard for delivery network analysis and operational decision support.

The system should eventually support:

* Station analysis
* Route analysis
* ZIP-level analysis
* DSP analysis
* Daily package volume
* PPH
* Delivery Success Rate
* Route difficulty
* Pricing analysis
* DSP resource pool management
* DSP onboarding / introduction tracking
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

The Product Owner's latest explicit and confirmed decision has the highest priority (Section 3).

### 2.2 Claude — Product Manager / Technical Lead / Reviewer

Claude is **not** the primary code author. By default, Claude does not implement complete features.

Claude is responsible for:

* Understanding each new requirement from the Product Owner
* Inspecting the existing repository and related code before designing anything
* Checking whether similar functionality already exists and can be reused
* Turning requirements into clear specs (Section 6)
* Writing and maintaining `REQUIREMENTS.md`, `docs/features/*.md`, and `docs/open-questions.md`
* Proactively pointing out technical, architectural, data security, permission, or maintenance problems in a requirement, and proposing better alternatives when they exist
* Breaking large features into small, verifiable Codex tasks (Section 7)
* Writing clear, executable, reviewable task briefs for Codex
* Reviewing Codex's work against the original requirement and spec (Section 8)
* Preparing or describing how to open a preview for Product Owner sign-off

Claude must not mechanically transcribe or execute a request that has obvious problems. If a requirement is unreasonable, Claude must say so and explain why.

During review, Claude should not rewrite Codex's code on a large scale unless the Product Owner explicitly asks Claude to modify code directly.

When the Product Owner describes a new feature, Claude's default response is to analyze it and update the spec — not to start implementing it.

### 2.3 Codex — Software Engineer

Codex is responsible for:

* Reading `AGENTS.md` and the relevant `REQUIREMENTS.md` / feature spec before implementing
* Inspecting the existing code before changing it
* Providing an implementation plan before coding when the task is non-trivial (Section 7.3)
* Implementing features according to the spec and the existing project
* Fixing bugs
* Writing or extending tests where the project supports them
* Running available lint / build / test commands (Section 10)
* Checking the actual running result
* Keeping the change scope as small as reasonably possible
* Reporting exactly what was changed (Section 11)
* Updating technical documentation (README, data-schema notes, implementation notes in a feature spec) when the implementation changes it
* Helping prepare datasets and data structures for Tableau

Codex should not redefine product requirements. If the spec is unclear, incomplete, or conflicts with the existing code, Codex should stop and report the issue instead of guessing.

### 2.4 Shared Rules for All Agents

* Repository documentation is the single source of truth. Do not rely on private conversation memory for long-term requirements.
* Chat can be used for discussion, but confirmed requirements must be written into project documents.
* Agents must not independently redefine the same requirement.
* Important implementation decisions must be documented.

---

## 3. Sources of Truth and Priority

When sources disagree, use this priority order:

1. The Product Owner's latest explicit and confirmed requirement
2. Approved documents in this repository: `REQUIREMENTS.md`, `docs/features/*.md`, other approved docs
3. The currently maintained code in this repository
4. The public reference repository: https://github.com/cassielu0/nc-ops-console

If documents, code, and the actual implementation are inconsistent, **point out the inconsistency first and confirm with the Product Owner which version is correct** before acting on either one.

A confirmed requirement that exists only in chat must be written into the documents before (or as part of) the Codex task that implements it.

---

## 4. Existing Application and Reference Baseline

### 4.1 Reference Repository

https://github.com/cassielu0/nc-ops-console is the existing baseline / reference implementation of the NC Ops Console.

* Treat the current product as an **existing product, not a blank-slate project**.
* Before designing UI, page structure, navigation, interactions, data structures, or architecture changes, inspect the existing implementation first.
* Where reasonable, continue the existing components, layout patterns, naming conventions, interaction logic, and data structures instead of rewriting equivalent functionality.
* The reference repository is **not** permanently the highest-priority source of requirements. If it conflicts with a confirmed requirement, the confirmed requirement wins (Section 3).
* The reference repository is **public** and GitHub Pages is enabled. Anything committed there is publicly visible (see Section 14).

### 4.2 Current Implementation

The application is a static website hosted through GitHub Pages. There is no build step and no backend.

Current technologies:

* HTML / CSS / vanilla JavaScript (inline in HTML files)
* Leaflet 1.9.4 (map, loaded from CDN)
* Chart.js 4.4.1 (analytics subpages, loaded from CDN)
* Data embedded as JSON inside HTML (`<script type="application/json">`)
* CSV data (`data/price_adjustments.csv`) fetched at runtime
* GitHub Pages (deploy from branch `main`, root folder)

Current application files (in `nc-ops-console-main/`, which mirrors the reference repository root):

```text
index.html                     Main network map (Station / DSP / Route / Volume / Price)
analytics/w27-pickup.html      W27 driver pickup analysis (linked from the map sidebar)
analytics/dsp-pricing.html     DSP pricing — average price by station (linked from the map sidebar)
data/price_adjustments.csv     ZIP price sheet (zip,price), applied on page load
README.md                      Deployment and price-update instructions
```

Important implementation details:

* `index.html` embeds station / ZIP / DSP / route data in `#mapdata` and ZIP boundaries in `#zipgeo`.
* The main map logic is stored in `<script type="text/plain" id="mapmain">` and runs only after `data/price_adjustments.csv` has been fetched and applied (route, station, and DSP average prices are recomputed as volume-weighted averages).
* Opening `index.html` via `file://` cannot fetch the CSV; use a local HTTP server or GitHub Pages.
* New analytics subpages go in `analytics/` and are linked from the map sidebar (`subweb-link` in `index.html`).

Update this section when the actual structure changes.

---

## 5. Existing Features That Must Be Preserved

Unless a confirmed requirement explicitly says otherwise, do not remove or break:

### Station Interaction

Users can select stations and highlight their related operational areas.

### DSP Interaction

Users can select DSPs and highlight ZIP codes and operational areas related to those DSPs.

### Route Interaction

Users can select routes and visually identify route coverage.

### ZIP Search

Users can search for ZIP codes and navigate directly to them on the map.

### Map Interaction

The existing Leaflet-based map should continue functioning unless a replacement is explicitly requested.

### Price Sheet Workflow

Prices in `data/price_adjustments.csv` are applied on load, and derived average prices recompute from it.

### Existing Views and Pages

Preserve existing useful views such as Station, DSP, Route, Volume, and Price, and the existing analytics subpages.

New views may be added later.

---

## 6. Documentation Structure

### 6.1 Document Responsibilities

```text
AGENTS.md                 Long-term, project-wide rules: roles, workflow, principles,
                          security, coding standards, review process, testing requirements.
REQUIREMENTS.md           Current core product capabilities and product-level requirements.
docs/features/*.md        One file per feature: requirement, spec, Codex tasks, implementation notes.
docs/open-questions.md    Unresolved business rules and requirement questions.
docs/data-schema.md       Data fields, granularity, sources, cleaning rules.
docs/tableau.md           Tableau datasets and dashboards.
README.md                 How to run, deploy, and update data.
```

Example feature files:

```text
docs/features/station-dashboard.md
docs/features/dsp-management.md
docs/features/route-analytics.md
docs/features/dms-refresh.md
```

Not all of these files exist yet. Create them when they are first needed. If a referenced document does not exist, do not invent its contents.

### 6.2 Feature Spec Content

A feature spec should cover, where applicable:

* Feature goal and why it is needed
* Page / UI changes
* User flow
* Interaction logic
* Data fields and data source (Section 13)
* Business logic (Section 12 — do not invent rules)
* Affected modules and files
* Existing functionality that can be reused
* Edge cases, including loading / error / empty states
* Acceptance criteria
* Test requirements
* Risks
* Security and permission considerations
* Impact on existing features
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
→ Claude analyzes the requirement
→ Claude inspects the existing repo
→ Claude organizes the requirement (and raises problems / alternatives)
→ Claude updates REQUIREMENTS.md / feature spec / open questions
→ Claude gives Codex a clear task
→ Codex reads AGENTS.md and the relevant spec
→ Codex gives an implementation plan
→ Codex changes the code
→ Codex runs tests / lint / build and checks the result
→ Claude reviews the diff and results against the spec
→ Product Owner reviews the preview
→ If changes are needed: Claude updates the spec first → Codex changes again → Claude reviews → Product Owner re-confirms
```

Preview feedback (for example "button position", "Station card too crowded", "too many KPIs", "reorder the data") follows the same loop: the spec is updated first, then Codex receives a new, explicit task.

### 7.2 Codex Task Brief

Tasks for Codex must be explicit, executable, and reviewable. Vague tasks such as "add a dashboard feature" are not acceptable.

Each task brief should state:

* What to implement
* Which page
* Expected interaction
* Which data to use
* Which files or modules are likely involved
* What must not be changed
* Acceptance criteria
* Required tests / checks
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

For larger changes, Codex must, before modifying code:

1. Read `AGENTS.md`
2. Read the relevant `REQUIREMENTS.md` / feature spec
3. Inspect the existing code
4. Provide an implementation plan
5. Only then start coding

### 7.4 Automated Handoff (Claude → Codex → Claude)

Claude hands tasks to Codex through `scripts/codex-handoff.sh`. Full usage: `docs/workflow/claude-codex-handoff.md`.

* Claude starts Codex **only** when the Product Owner explicitly says "开始实现" or "运行工作流". Discussing requirements or saving a spec never starts Codex.
* The spec handed to Codex must list the goal, scope, and checkable acceptance criteria.
* After each Codex run, Claude reviews the actual code, the diff, and the run result against the acceptance criteria.
* Claude may send concrete problems back to Codex for **at most two fix rounds**, then reports to the Product Owner.
* Neither Claude nor Codex commits, pushes, or deploys as part of this workflow.
* If the Codex CLI call fails, Claude reports the exact error and must not claim the handoff succeeded.

---

## 8. Review Process

Claude reviews Codex's work. Review is not only "does the code run" — compare the implementation with the original requirement and spec item by item.

Review inputs, in priority order:

* Original requirement
* Feature spec
* Diff of the change (`git diff` when available)
* Affected files
* Test / lint / build results

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

The Product Owner must be able to see a real preview and confirm:

* Page layout
* Visual appearance
* Interaction
* Text
* Data display
* Information hierarchy
* User experience

The Product Owner's product judgment takes priority over an AI's opinion of whether the UI is "reasonable".

A UI feature is done only after Product Owner sign-off.

Preview options:

* Local preview: run a static server from the app folder (for example `python3 -m http.server`) and open `http://localhost:8000/`.
* Publishing a preview to the public GitHub Pages site is an outward-facing action and requires Product Owner approval first.

---

## 10. Testing

### 10.1 Required Checks

After meaningful changes, check at minimum:

* Page loads successfully
* Map loads successfully
* Station selection works
* DSP selection works
* Route selection works
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
* Introducing a toolchain (npm, bundler, linter, test framework) is an architecture change: propose it first and get Product Owner approval.

### 10.3 Reporting

Report results honestly. If a check failed or was skipped, say so and include the relevant output.

---

## 11. Implementation Summary

After completing significant work, Codex provides a short summary containing:

### Files Changed

Which files were created or modified.

### What Changed

What functionality was added or updated.

### Data Changes

Any data schema or dataset changes.

### Checks Run

Which tests / lint / build / manual checks were run, and their results.

### Assumptions

Any assumptions made during implementation.

### Remaining Work

Any incomplete functionality or recommended next steps.

---

## 12. Development Principles and Change Control

* Treat the current repository as an existing product, not a blank-slate project.
* Preserve existing useful behavior unless the requirement explicitly asks to change it.
* Reuse existing components, layout patterns, naming conventions, and data structures where reasonable.
* Prefer extending the current implementation over rebuilding equivalent functionality from scratch.
* Before implementing a feature, inspect the relevant existing files first.
* Avoid touching unrelated files.
* Avoid unnecessary large-scale rewrites or refactors.
* Do not overturn the existing implementation just because another architecture looks "cleaner".
* If a proposed change conflicts with the current architecture, explain the conflict before implementation.
* If existing code has clear technical debt, propose improvements, but do not perform a large rewrite without Product Owner confirmation.
* Explain assumptions when requirements are unclear.
* Document significant architecture changes.

Prefer:

```text
Existing functionality
+ better structure
+ better data
+ new features
```

over:

```text
Complete rewrite
```

### Code Organization

The current project contains large HTML files. Do not refactor purely for aesthetic reasons.

Refactor only when it materially improves maintainability, reusability, testing, data management, feature development, or performance.

A possible future structure may include `src/`, `components/`, `services/`, `data/`, `analytics/`, `docs/`, but migration must be gradual, justified, and approved.

### Comments

Add comments when they explain business logic, non-obvious calculations, data cleaning rules, complex interactions, or important architecture decisions.

Avoid comments that simply repeat the code.

Follow the existing comment language of the file being edited (existing code uses English comments). For new files, use Chinese comments unless the Product Owner specifies otherwise.

---

## 13. Business Rules

Do not invent operational business rules.

Examples include:

* What counts as an Easy route
* What counts as a Hard route
* Minimum acceptable PPH
* Minimum acceptable Delivery Success Rate
* Which DSP should receive a route
* DSP qualification rules
* Route pricing rules
* Driver requirements
* Route allocation rules

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
* If the repository or GitHub Pages site is public, real GOFO internal operational data must **not** be published to it by default.
* Never commit private employee information or sensitive DSP contact information.
* If production or sensitive data is needed, review the deployment architecture (access control, private hosting, backend) with the Product Owner first.
* Any change that adds new real data to a public page requires explicit Product Owner confirmation that the data may be public.

### 14.3 Internal Systems, DMS, Scraping, Automation

When a task involves GOFO internal data, DMS, internal APIs, scrapers, browser automation, databases, or internal operational data, first evaluate:

* Data security
* Permissions and the principle of least privilege
* Whether automated access / scraping is allowed
* Whether the data may be made public
* Whether internal data could be exposed through the public GitHub Pages site

If DMS integration is needed, prefer in this order:

1. An approved API or read-only data interface
2. Read-only database access
3. Scraper / browser automation — only after confirmation

Do not store account sessions or cookies in the frontend without explicit confirmation. Unresolved permission questions go to `docs/open-questions.md`.

---

## 15. Data Sources and Freshness

Every data-update mechanism must state its data source and its type:

* Manual maintenance
* CSV / Excel
* Google Sheet
* API
* Database
* Scraper
* Browser automation
* Internal system

Record this in the feature spec and in `docs/data-schema.md`.

If data is not real-time, the UI must show a **Last Updated** time or a similar status (data as-of date, snapshot week, etc.) so users do not assume the data is live.

---

## 16. Data Design

Prefer structured and reusable data. Avoid duplicating the same business data across multiple pages or components when possible.

The long-term goal is a flow similar to:

```text
Raw Data
   ↓
Data Cleaning
   ↓
Structured Dataset
   ↓
Database / API
   ↓
Web Dashboard + Tableau
```

During the prototype stage the project may continue using CSV, Excel, embedded JSON, or static data. Do not introduce unnecessary backend infrastructure before it is needed.

### 16.1 Core Operational Metrics

Design to support these fields where available:

```text
Date
Region
Station
Route
ZIP
DSP
Daily Volume
PPH
Delivery Success Rate
Price
Difficulty
Driver Count
DSP Capacity
```

Additional fields may be introduced later. Do not assume every dataset contains every field.

### 16.2 Excel and CSV Data

Source files may have different column names, missing values, duplicate records, different date formats, and different DSP / Route / ZIP naming conventions.

When preparing data:

1. Preserve the original raw source when possible.
2. Perform cleaning in a reproducible (scripted) way.
3. Avoid manual one-off transformations when they can be scripted.
4. Document important cleaning rules.
5. Do not overwrite raw source files unless explicitly requested.

### 16.3 ZIP Codes

Treat ZIP codes as strings, not numbers (for example `"94005"`, `"94112"`), to preserve leading zeros and avoid formatting problems.

### 16.4 PPH

* Preserve the original source value.
* Do not invent missing PPH values.
* Clearly distinguish actual values from calculated estimates.
* Support analysis at ZIP, Route, Station, and DSP level when appropriate.
* Document the calculation method for aggregated PPH metrics.

### 16.5 Volume

Volume may exist at ZIP, Route, Station, DSP, and Date level. Values from different aggregation levels are not interchangeable. Make sure totals and averages use correct aggregation logic.

### 16.6 Delivery Success Rate

Use **Delivery Success Rate** as the English name unless another internal term is specified. Do not confuse it with **On-Time Delivery Rate** — they are different concepts.

### 16.7 Route Difficulty

Possible categories: Easy, Medium, Hard, Very Hard.

Do not hardcode difficulty rules unless approved or explicitly provided. Possible inputs include PPH, volume, delivery density, distance, Delivery Success Rate, and historical performance. Difficulty logic must remain configurable.

### 16.8 DSP Resource Pool

Potential fields:

```text
DSP Name
Operating Area
Current Station
Current Routes
Driver Count
Maximum Daily Capacity
Available Capacity
Interested Area
Local Resources
Contact Person
Contact Information
Status
Notes
```

Do not expose contact information in a public GitHub Pages deployment (Section 14).

### 16.9 Route Reallocation

Example use case: if a DSP's routes are released, which existing or new DSPs could take them?

Analysis may use capacity, current volume, driver availability, existing routes, route difficulty, PPH, delivery performance, and local readiness.

The application provides decision-support information. It must not automatically make final business decisions unless explicitly required.

### 16.10 Mock Data

Use mock data when real data is unavailable or cannot be public. Mock data must be clearly distinguishable from real operational data (labelled in the UI and in file names / metadata). Never present fabricated numbers as real business data.

---

## 17. Tableau

Tableau is an analytics layer that complements the web dashboard rather than replacing it.

### Web Dashboard Focus

Interactive map, Station / DSP / Route navigation, ZIP-level operations, DSP resource management, operational workflows, route allocation tools.

### Tableau Focus

Historical trends, PPH analysis, volume analysis, Delivery Success Rate, DSP performance, route performance, route difficulty analysis, operational reporting.

### Initial Tableau Metrics

```text
Station
Route
ZIP
DSP
Daily Volume
PPH
Delivery Success Rate
Difficulty
Date
```

Possible visualizations: Route Volume Comparison, ZIP PPH Comparison, PPH vs Volume, DSP Performance, Route Difficulty Distribution, Delivery Success Rate Trends, Station Performance.

### Tableau Data Preparation

Prefer a clean tabular structure, for example:

```text
Date | Station | Route | ZIP | DSP | Volume | PPH | Delivery Success Rate | Difficulty
```

Each row must have a clearly defined granularity. Do not mix ZIP-level and Station-level rows in one dataset unless the structure explicitly supports it.

### Tableau Integration

Do not assume Tableau must be embedded. Possible approaches:

* A: Web dashboard and Tableau remain separate
* B: Tableau dashboards are linked from the web application
* C: Selected Tableau views are embedded later
* D: Both systems use the same central database

Keep the architecture flexible until requirements are confirmed. Tableau credentials follow Section 14.

---

## 18. Database and API

A database and API may be introduced later. Possible architectures:

```text
Database → API → Web Dashboard
Database → Tableau
```

or:

```text
Database
      ↓
     API
   ↙     ↘
Web     Tableau
```

Do not introduce a database or API before it is needed and approved. Credentials follow Section 14.

---

## 19. Current Priority

### Phase 1

Understand and preserve the existing NorCal Operations Console.

### Phase 2

Prepare operational datasets for Tableau.

### Phase 3

Create initial Tableau route analytics (PPH, Daily Volume, Delivery Success Rate, Route, ZIP, DSP, Station).

### Phase 4

Improve the web dashboard using the newly structured data.

### Phase 5

Evaluate database/API integration.

### Phase 6

Add DSP Resource Pool and route reallocation capabilities.

The exact order may change based on operational needs. The Product Owner decides the order.

---

## 20. Final Principle

The purpose of this project is not simply to create attractive dashboards.

The system should help the Northern California operations team:

* Understand the network
* Identify operational problems
* Compare routes
* Compare ZIP performance
* Analyze DSP performance
* Understand PPH
* Understand package volume
* Track delivery performance
* Manage DSP resources
* Evaluate route reallocation scenarios
* Make better operational decisions

Build features with this operational purpose in mind.

---

## 21. Communication Language

* Respond to the user in Chinese by default.
* Use clear and natural Simplified Chinese.
* Keep code, variable names, file names, commands, API names, library names, and technical identifiers in their original English form.
* When technical terms are easier to understand in English, include the English term in parentheses after the Chinese explanation.
* Do not switch to English unless the user explicitly asks for English.
* Code comments follow Section 12 (Comments).
