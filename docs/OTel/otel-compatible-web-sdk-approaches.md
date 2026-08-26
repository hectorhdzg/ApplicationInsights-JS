# OpenTelemetry-compatible Web SDK — approaches

- **Status:** draft · **Author:** hectorhdzg · **Last updated:** 2026-08-26
- **Related:** [Rayfin OTel support plan](./rayfin-otel-support-plan.md) — the ask driving this effort.

> **Scope.** Weigh the **three approaches** to deliver an OpenTelemetry-compatible Web (browser)
> SDK for Application Insights, with pros/cons, so we can pick a direction. Living document.

## 1. Summary

We want a browser SDK whose public API is **OpenTelemetry-compatible** (traces, logs, and basic
metrics) while meeting web constraints: small bundle, multiple isolated instances, complete
unload/cleanup, and a graceful fallback on old browsers. Telemetry must be exportable to Azure
Monitor (Breeze) and/or an **OTLP** endpoint. This spec weighs **three** ways to get there:
**(1)** build our own OTel-compatible Web SDK (in progress), **(2)** adopt the community OTel
Browser SDK, or **(3)** extend the existing Application Insights Web SDK.

## 2. Motivation / problem

- **Driving ask — the Rayfin SDK.** Rayfin codes exclusively against the standard
  `@opentelemetry/api` (+ `@opentelemetry/api-logs`) globals (`trace`, `context`, `propagation`,
  `logs`, `metrics`) and expects a **host-registered provider** underneath. It will **never** depend
  on Application Insights directly. AI is asked to **be that provider in the browser** — i.e. ship a
  bridge that registers behind `@opentelemetry/api`. Phased **P0 traces+context+propagation → P1 logs
  → P2 metrics**; the make-or-break item is an **async `ContextManager`** that survives `await`. Full
  gap analysis + phasing: [rayfin-otel-support-plan.md](./rayfin-otel-support-plan.md).
- The classic Application Insights Web SDK predates OpenTelemetry and uses its own telemetry
  contracts (`ITelemetryItem`). Customers increasingly expect the OTel API surface and ecosystem.
- **A native, first-party OTLP exporter is a primary driver for building this SDK.** Customers want
  to send browser telemetry to **any OTLP endpoint / collector** (not just Azure Monitor). The
  classic SDK and the existing options don't provide a clean, supported browser OTLP path, so this
  is a core reason to create a new OTel-compatible Web SDK.
- The community `@opentelemetry/*` browser packages assume a **single global** provider and
  register globals on import — which conflicts with our need for **multi-instance isolation** and
  minimal bundle size in the browser.

## 3. Goals / non-goals

**Goals**
- OTel-compatible API for **traces + logs** (metrics: basic/"nice to have" initially).
- **Native OTLP exporter (OTLP/HTTP)** — a first-class goal and a key reason for this SDK: export
  browser telemetry to any OTLP endpoint/collector, keeping bundle/perf cost in check (efficient
  encoding, batching, `sendBeacon`/`fetch` with keepalive).
- Export to **Breeze** (Azure Monitor) / **1DS**; reuse classic channels where possible.
- **Multi-instance**, **no global state**, **complete unload**, **ES2020+** with an **ES5 no-op** fallback.
- W3C **TraceContext** + **Baggage** propagation for distributed tracing.

**Non-goals (for now)**
- Full metrics SDK parity with the OTel spec.
- Node.js server SDK (covered elsewhere — Azure Monitor OpenTelemetry Distro for Node).
- Server-side auto-instrumentation / in-process agents.

## 4. The three approaches

### Approach 1 — Build our own OpenTelemetry-compatible Web SDK *(in progress — our goal)*

Purpose-built browser SDK that exposes an **OpenTelemetry-compatible** API by defining `IOTel*`
TypeScript interfaces and `create*` factories, **without importing `@opentelemetry/*`**.
Compatibility is by structural (duck) typing. Work is already underway on the `otel-sdk` branch
(`@microsoft/otel-core-js` + `@microsoft/otel-noop-js`), governed by `shared/otel-core/CONTEXT.md`
(IoC, no global state, closure pattern, interfaces-only public API, complete unload).

- **Pros**
  - **Multi-instance / no global state** — multiple isolated SDKs per page (multi-tenant / micro-frontend safe).
  - **Smallest bundle**: tree-shakeable, no upstream OTel deps; **ES5 no-op fallback** for legacy browsers.
  - **Full control** of API stability, perf hot paths, and Azure Monitor (Breeze) integration.
  - Fits enterprise requirements that the community SDK explicitly does **not** (see §4a).
  - Can **borrow proven pieces from the existing AI Web SDK** (AJAX/fetch tracing, channels, shims)
    rather than starting from zero.
- **Cons**
  - We **own and must track** the OTel spec surface ourselves (processors, samplers, propagators, metrics).
  - **Community instrumentations** (`@opentelemetry/instrumentation-*`) call the **global**
    `@opentelemetry/api`, so they won't auto-wire — mitigated by an **optional `@opentelemetry/api`
    bridge** package that delegates to a chosen instance (opt-in, keeps the core global-free).
  - Largest **net-new implementation effort** (later phases still to build).
  - **Duck-typing drift** risk as OTel evolves; needs conformance tests against the real API types.

### Approach 2 — Adopt the community OpenTelemetry Browser SDK

Build on [`open-telemetry/opentelemetry-browser`](https://github.com/open-telemetry/opentelemetry-browser)
(standard OTel, OTLP/HTTP export) plus a custom Azure Monitor exporter. **This is early-stage and
has plenty of gaps** — see the hands-on review in §4a.

- **Pros**
  - **Standards-based**; least OTel-spec surface for us to maintain (upstream owns it).
  - **First-party instrumentations today**: navigation, navigation-timing, resource-timing,
    user-action, web-vitals, console, errors; clean tree-shaking and CI size budgets.
  - Native **OTLP/HTTP** logs + traces; community propagators work out of the box.
- **Cons** *(the gaps)*
  - **No multi-app isolation** — registers OTel **global singletons** (first-writer-wins); two apps
    on a page collide. **Not on the roadmap** (the "zoneless policy" direction reinforces single-global).
  - **Modern-only**: **ES2022, no ES5/IE fallback** — loses our legacy reach.
  - **First-party HTTP (fetch/XHR) instrumentation not shipped**; needs the contrib
    `@opentelemetry/instrumentation-fetch` package.
  - **No Azure Monitor / Breeze exporter** — we'd have to build and maintain it anyway.
  - **OTel core + exporters dominate bundle size**; less control over API/perf; early-stage churn.

### Approach 3 — Extend the Application Insights Web SDK *(already does some tracing)*

Add the OTel-compatible API surface **on top of the existing, shipping AI Web SDK** (`AISKU` +
plugins). The classic SDK **already performs distributed tracing**: `distributedTracingMode`
(`AI_AND_W3C` / `W3C`) in `AISKU/src/Init.ts`, and W3C `traceparent`/`tracestate` injection with
operation correlation in the Dependencies plugin
(`extensions/applicationinsights-dependencies-js/src/ajax.ts`).

- **Pros**
  - **Reuse a mature, battle-tested pipeline**: batching, retry, throttling, sampling, **offline**
    channel, and **ES5/IE** support already in production.
  - **Already ships distributed tracing** (W3C correlation, dependency/AJAX tracking) — build on it.
  - **Smallest incremental effort** and the **cleanest migration** for existing AI customers.
- **Cons**
  - **Impedance mismatch**: the classic core is `ITelemetryItem`-shaped, not OTel `Span`/`LogRecord`;
    mapping links, events, resource, and exemplars is lossy/complex.
  - OTel API **bolted on top** can be leaky; inherits **legacy weight**, larger baseline bundle, and
    `DynamicProto` patterns the new core deliberately avoids.
  - Ties the new API to the classic core's lifecycle/config model; **not a clean-room OTel design**.

### Cross-cutting: exporter / pipeline options (largely independent of the three approaches)

| Option | What | Notes |
|--------|------|-------|
| **Breeze exporter** as `IOTelSpanProcessor` / `IOTelLogRecordProcessor` | Map OTel → Azure Monitor envelope | Primary Azure target; connection-string/iKey config |
| **OTLP exporter** (HTTP/protobuf) | Vendor-neutral export to a collector | **First-class goal for this SDK.** OTLP/HTTP over `sendBeacon`/`fetch` (port 4318); gRPC not viable in-browser. Keep bundle/perf in check with efficient encoding + batching. (An earlier position against browser OTLP has been superseded — requirements changed.) |
| **Reuse classic channels** | Offline/retry/throttle from AISKU | Central to Approach 3; also usable as a processor sink in Approach 1 |
| **1DS post channel** | `1ds-post-js` transport | Relevant if OneCollector/1DS ingestion is in scope |

## 4a. Evidence — state of the community OpenTelemetry Browser SDK (Aug 2026)

A hands-on review of `open-telemetry/opentelemetry-browser` (`main`, with bundle measurements)
directly informs the choice against **Approach 2**. Key findings:

- **Multi-app / micro-frontend isolation is NOT solved and NOT tracked.** The SDK registers
  providers into OTel **global singletons** (`setGlobalTracerProvider` / `setGlobalLoggerProvider`
  + global propagator/context manager) and returns only a shutdown handle — not the provider.
  Global API is **first-writer-wins**, so two apps on one page collide (app #2's telemetry flows
  through app #1's provider/exporter/resource). The adjacent "zoneless policy" direction
  **reinforces** the single-global assumption. This is a hard blocker for multi-tenant needs.
- **Modern browsers only.** Build target **ES2022, no ES5/legacy fallback** (no IE11 / pre-2022).
  Contrast: Application Insights JS still carries **ES5/IE** support — a real differentiator.
- **First-party HTTP (fetch/XHR) instrumentation is not shipped**; needs contrib for now.
- **Bundle:** the **OTel core SDK + exporters dominate the cost** (min+gzip: SDK+exporters ~20 KB,
  realistic minimal ~22 KB, everything ~30 KB) — i.e. adopting Approach 2 is what makes the bundle big.

**Implication:** the community browser SDK is fine for the **single-app, modern-browser** case but
fails **multi-app isolation** and **legacy-reach** requirements — both of which **Approach 1**
satisfies. Reason to **not** adopt **Approach 2** as the base; treat it as a standards/interop
reference and expose ecosystem compatibility via an **`@opentelemetry/api` bridge** on our own SDK.

## 5. Comparison at a glance

| Criterion | 1. Build our OTel Web SDK | 2. Community OTel Browser SDK | 3. Extend AI Web SDK |
|-----------|---|---|---|
| Multi-instance / no globals | Strong | Weak | Good |
| Bundle size | Strong | Mixed (OTel core dominates) | Mixed (legacy weight) |
| Ecosystem instrumentation compat | Mixed (bridge) | Strong | Weak |
| Unload / cleanup | Strong | Mixed | Good |
| Old-browser (ES5/IE) support | Good (no-op pkg) | Weak (ES2022 only) | Strong (shipping) |
| OTel spec surface we must maintain | We own it | Upstream | Mapping layer |
| Azure Monitor / Breeze export | Strong (native intent) | Weak (build it) | Strong (already ships) |
| Distributed tracing today | Mixed (in progress) | Good | Strong (W3C live) |
| Migration for existing AI customers | Mixed | Weak | Strong |
| Net-new effort | Highest | Medium | Lowest |

_Ratings: Strong &gt; Good &gt; Mixed &gt; Weak (qualitative)._

## 6. Leaning / recommendation (draft)

**Approach 1 (build our own OTel-compatible Web SDK) is the goal and is already underway.** It is
the only option that meets all of the hard requirements at once — **multi-instance isolation**,
**ES5/legacy reach**, **minimal bundle**, and **first-class Breeze export**. The review in §4a shows
**Approach 2** cannot meet the first two and would still require us to build a Breeze exporter, so
it's a **reference/interop target**, not the base. **Approach 3** is the fastest path and should not
be discarded: its mature pipeline and **already-shipping W3C distributed tracing** are assets we
should **harvest into Approach 1** (AJAX/fetch tracing, channels, shims) rather than rebuild.

**Rayfin implication.** The Rayfin ask makes the **global `@opentelemetry/api` bridge a P0
deliverable**, not merely opt-in: Rayfin only compiles against the `@opentelemetry/api` globals, so
AI must register a global `TracerProvider` / `ContextManager` / `TextMapPropagator` (then logs,
metrics). The Rayfin plan's recommended **"Option A — OTel API bridge"** is exactly this bridge
layered on our OTel core / the AISKU. The **highest-risk item is an async `ContextManager`** that
survives `await`; Rayfin accepts a **synchronous manager + explicit-parent `startSpan(name, opts,
context)`** as the minimum viable P0 slice. See [rayfin-otel-support-plan.md](./rayfin-otel-support-plan.md).

## 7. Impact

**SDL / privacy:** connection string/iKey is sensitive (never log); Breeze/OTLP endpoints over TLS;
align with the Application Insights JS SDK SDL threat model; provide the Rayfin PII redaction hook
(strip URL query string, drop `Authorization`). **Compatibility:** OTel API conformance; W3C
TraceContext interop. **Performance:** bundle size + hot-path overhead are first-order. **Rollout:**
alpha packages, phased per Rayfin P0 → P2.

## 8. Open questions

- Is **community instrumentation** support required beyond Rayfin? (Sizes the `@opentelemetry/api` bridge.)
- **Async `ContextManager`** approach (Zone vs. microtask/`AsyncContext`) — the make-or-break item.
- How much of the **AI Web SDK** (dependency/AJAX tracing, channels, shims) do we reuse vs. rebuild?
- **OTLP** (a goal): JSON vs protobuf encoding; bounding bundle/perf; `sendBeacon`/keepalive on unload.
- Metrics: basic counters/gauges in v1, or defer per Rayfin P2.

## 9. Decision

_Not yet decided._ This document will be updated once a direction is ratified.
