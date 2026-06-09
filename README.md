# HTML Audit Agent

An AI-powered web page auditor that scores HTML against five best-practice dimensions: **LLM-Friendliness**, **W3C Compliance**, **SEO**, **Semantic HTML**, and **Accessibility (WCAG 2.1)**.

Supports two modes:
- **AI Audit** — uses an LLM (via [OpenRouter](https://openrouter.ai) or a compatible endpoint) to reason deeply about the HTML
- **Rule-based Audit** — fully deterministic, no API key required

To run, Download the project and run the HTML file.
---

## Features

- **Paste HTML directly** — no URL or server needed; audit any fragment or full page
- **URL audit** — fetch and audit any live page by URL
- **Bulk audit** — upload a CSV of URLs and audit them all sequentially
- **OpenRouter integration** — bring your own `sk-or-*` key; the agent auto-routes to `openrouter.ai`
- **Zero-key fallback** — deterministic rule-based audit runs entirely on the server with no AI required
- **Streaming progress** — fire-and-forget jobs with live polling so the UI never blocks
- **PDF export** — download a formatted audit report
- **Five scored criteria**, each with severity-tagged issues (error / warning / info) and HTML snippet evidence

---

## Audit Criteria

| Criterion | What is checked |
|---|---|
| **LLM-Friendly HTML** | Heading hierarchy, landmark coverage, layout tables, deep wrapper nesting, JS-only content |
| **W3C Compliance** | Invalid parent-child nesting, deprecated tags, nested interactives, duplicate IDs, missing `alt` |
| **SEO** | Title tag, meta description, canonical, viewport, JSON-LD, hreflang, robots meta |
| **Semantic HTML** | Landmark elements, `section`/`article` without headings, div-soup ratio, content-model rules |
| **Accessibility (WCAG 2.1 A/AA)** | Missing `alt`, unlabelled inputs, positive `tabindex`, `aria-hidden` on focusable elements, skip links |

Plus a **Doc Size** breakdown: HTML-to-text ratio, inline CSS/JS bloat, external resource counts, unused JS/CSS coverage.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui |
| Backend | Node.js, tRPC, Zod |
| LLM integration | OpenAI-compatible REST (OpenRouter, or any compatible endpoint) |
| Testing | Vitest |

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm or pnpm

### Install

```bash
git clone https://github.com/sayanrup/HTML_Auditor_Agent.git
cd HTML_Auditor_Agent
npm install
```

### Environment variables

Copy `.env.example` to `.env` and fill in the values you need:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `LLM_PROVIDER` | For server-side AI | `openai`, `anthropic`, or `google` |
| `LLM_API_KEY` | For server-side AI | Server-side API key |
| `LLM_MODEL` | Optional | Default model (e.g. `openai/gpt-4.1-mini`) |
| `LLM_BASE_URL` | Optional | Override endpoint (default: OpenAI-compatible) |

> **Note:** You can skip all of the above and instead enter your **OpenRouter API key** directly in the app UI — it is stored in your browser's `localStorage` and never sent to any server other than OpenRouter.

### Run

```bash
npm run dev
```

The app starts at `http://localhost:5000`.

---

## Usage

### HTML Audit (paste mode)

1. Open the app — the default page is the **HTML Audit** interface
2. Optionally enter your **OpenRouter API key** (`sk-or-v1-…`) and choose a model
3. Paste any HTML into the textarea
4. Click **Audit HTML**
   - With a key → AI audit via OpenRouter
   - Without a key → deterministic rule-based audit

### URL Audit

Navigate to `/audit`, enter a URL, and choose **AI Audit** or **Rule-based**.

### Bulk Audit

On the `/audit` page, switch to **Bulk Audit**, upload a CSV file (one URL per row), and start. Results appear as each URL completes.

---

## Project Structure

```
├── client/              # React frontend (Vite)
│   └── src/
│       ├── pages/
│       │   ├── HtmlAuditPage.tsx   # HTML paste + OpenRouter UI
│       │   └── AuditPage.tsx       # URL + bulk audit UI
│       └── components/
│           └── AuditResults.tsx    # Shared results display
│
└── server/              # Node.js backend (tRPC)
    ├── routers.ts              # All API routes
    └── services/
        ├── llmEvaluator.ts     # AI audit rubrics + LLM orchestration
        ├── ruleBasedAuditor.ts # Deterministic rule-based checks
        ├── llmClient.ts        # OpenRouter / LLM HTTP client
        ├── htmlTextMetrics.ts  # HTML-to-text ratio, bloat analysis
        └── auditOrchestrator.ts
```

---

## OpenRouter Setup

1. Sign up at [openrouter.ai](https://openrouter.ai) and create an API key
2. Paste your `sk-or-v1-…` key into the **OpenRouter API Key** field in the app
3. Pick a model from the dropdown (default: `openai/gpt-4.1-mini`)

Keys starting with `sk-or-` are automatically routed to `https://openrouter.ai/api/v1` — no server configuration needed.

---

## License

MIT
