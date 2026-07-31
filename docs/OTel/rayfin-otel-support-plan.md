---
title: Planning — Supporting the Rayfin SDK OpenTelemetry API Usage Catalog
status: draft
audience: Application Insights JS team
purpose: Enumerate the work required for the AISKU to satisfy the Rayfin SDK "OpenTelemetry API Usage Catalog", based on a gap analysis of the current OTel-compatible tracing implementation.
lastReviewed: 2026-07-31
---

# Planning — Supporting the Rayfin SDK OpenTelemetry API Usage Catalog

## 1. Executive summary

The Rayfin SDK does **not** consume Application Insights directly. It codes exclusively against the
standard `@opentelemetry/api` (and `@opentelemetry/api-logs`) packages and expects a *host-registered
provider* to sit underneath the global OTel singletons (`trace`, `context`, `propagation`, `metrics`,
`logs`). Application Insights is asked to be that provider — a browser-side implementation registered
behind `@opentelemetry/api`.

Today the AISKU ships an **OpenTelemetry-*compatible* tracing API** (`appInsights.otelApi`) that is
*instance-based* and *not wired into the global `@opentelemetry/api` registry*. It covers most of the
span surface Rayfin needs for traces, but has three structural gaps that block the catalog:

1. **No bridge to the global `@opentelemetry/api` singletons.** Rayfin calls `trace.getTracer(...)`,
   `context.active()`, `propagation.inject(...)` — the static exports of `@opentelemetry/api`. Nothing in
   the AISKU registers itself as the global `TracerProvider` / `ContextManager` / `TextMapPropagator`.
2. **No async `ContextManager`.** This is Rayfin's single most important requirement (catalog §6.1).
   There is no context manager that survives `await` / microtask boundaries.
3. **No propagation, metrics, or logs APIs.** `propagation`, `metrics` and `logs` do not exist in the
   current implementation (the `metrics?`/`propagation?` fields are commented out in `IOTelApi`).

This document maps every catalog line item to its current state and the work required, and proposes a
phased delivery that mirrors Rayfin's own P0 → P1 → P2 ordering (traces → logs → metrics).

## 2. The central architectural decision

> **Rayfin imports from `@opentelemetry/api`. We must decide how AI backs those global singletons.**

Two options:

| Option | Description | Assessment |
|---|---|---|
| **A — OTel API bridge (recommended)** | Ship a package that adapts the AISKU's internal OTel implementation to the official `@opentelemetry/api` provider contracts and registers it globally: `trace.setGlobalTracerProvider()`, `context.setGlobalContextManager()`, `propagation.setGlobalPropagator()` (and later `logs.setGlobalLoggerProvider()`, `metrics.setGlobalMeterProvider()`). | **Matches the catalog exactly.** Rayfin's dependency contract (§3) is API-only; the host app registers the provider via "a thin bootstrap package" — this bridge *is* that package. No-op safety (§6.2) comes for free from `@opentelemetry/api`. |
| **B — Native AI API only** | Rayfin codes against `appInsights.otelApi`. | **Rejected.** Rayfin explicitly will *never* depend on appinsights-js directly and codes only against `@opentelemetry/api`. This option does not satisfy the ask. |

**Recommendation: Option A.** The rest of this plan assumes a new bridge package (working name
`@microsoft/applicationinsights-otel-js` / "OTel provider bridge") that:

- takes `@opentelemetry/api` (and `@opentelemetry/api-logs`) as **peer dependencies**;
- adapts our internal `IOTelApi` tracer/span types to the official `Tracer`/`Span` interfaces;
- registers a real async `ContextManager` and a W3C `TextMapPropagator`;
- is initialized from an existing `AppInsightsCore` / AISKU instance.

This keeps the core free of a hard `@opentelemetry/api` dependency (preserving bundle size and
tree-shaking) while giving Rayfin the standard surface it compiles against.

## 3. Gap analysis — traces (Rayfin P0)

Legend: ✅ exists · ⚠️ partial / needs adaptation · ❌ missing.

| Catalog symbol (§4.1) | Current AISKU state | Work required |
|---|---|---|
| `trace.getTracer(name, version)` | ✅ `otelApi.trace.getTracer(name, version?, options?)` | Expose via bridge as the global `trace.getTracer`. |
| `tracer.startActiveSpan(name, options, fn)` | ✅ Implemented (multiple overloads). | Adapt callback to receive an official `Span`. Verify the 3-arg `(name, options, context, fn)` OTel overload is supported — currently only `(name, fn)` and `(name, options, fn)` exist. |
| `tracer.startSpan(name, options, context)` | ⚠️ `startSpan(name, options?)` — **no explicit `context`/parent argument**. | **Add explicit-parent support.** This is required for Rayfin's §6.1 mitigation (thread parent context manually). `ITraceProvider.createSpan` already accepts a `parent`, so the plumbing exists internally; expose it on the public tracer/bridge. |
| `span.setAttribute` / `setAttributes` | ✅ | Map through bridge span wrapper. |
| `span.setStatus({ code, message })` | ✅ | Map. |
| `SpanStatusCode.ERROR/OK/UNSET` | ✅ `OTelSpanStatus` enum | Re-export / map to official `SpanStatusCode`. |
| `span.recordException(error)` | ✅ | Map. |
| `span.end()` | ✅ | Map. |
| `SpanKind.CLIENT/INTERNAL` | ✅ `OTelSpanKind` (INTERNAL/SERVER/CLIENT/PRODUCER/CONSUMER, matching OTel values) | Map to official `SpanKind`. |
| `span.addEvent(name, attributes)` | ❌ **Commented out — events are dropped.** | **Implement span events.** Rayfin uses events for retry attempts, token-refresh milestones, and timeouts (§5.2). Requires: event storage on the span, plumbing through to the AI telemetry mapping (likely surfaced as trace/message telemetry or custom properties). |
| `span.isRecording()` | ✅ | Map. |
| `trace.getActiveSpan()` | ✅ `otelApi.trace.getActiveSpan()` | Expose via bridge, reading from the new `ContextManager`. |
| `trace.setSpan(context, span)` | ❌ No OTel `Context` object. AI uses `IDistributedTraceContext` + `setActiveSpan`. | **Introduce an OTel `Context` abstraction** in the bridge (or adapt) so `trace.setSpan` / `trace.getSpan` work against a real context object. |
| `context.active()` | ❌ | **Provide `context` API** via the registered `ContextManager` (see §5). |
| `context.with(context, fn)` | ❌ | Provide via `ContextManager`. |
| **Registered `ContextManager`** | ❌ **Missing — CRITICAL (§5).** | Build an async context manager. Highest-risk item. |
| `propagation.inject(context, carrier, setter)` | ❌ No `propagation` API. W3C primitives exist (`createTraceParent`, `formatTraceParent`, `parseTraceParent`, `findW3cTraceParent`). | **Build a W3C `TextMapPropagator`** on top of the existing primitives and register it. |
| **Registered W3C TraceContext propagator** | ❌ | Register default `W3CTraceContextPropagator` via `propagation.setGlobalPropagator`. |

### 3.1 What already works in our favour

- **Span core surface** (`setAttribute(s)`, `setStatus`, `recordException`, `updateName`, `end`,
  `isRecording`, `spanContext`) is implemented and documented in `docs/OTel/`.
- **`SpanKind` and `SpanStatusCode` enum values already match OTel.**
- **W3C trace-context primitives exist** in `AppInsightsCommon` / `1ds-core-js`
  (`createTraceParent`, `parseTraceParent`, `formatTraceParent`, `isValidTraceParent`, …).
- **Tracing suppression exists** (`suppressTracing`, `unsuppressTracing`, `isTracingSuppressed`),
  which directly answers Rayfin's §6.5 "don't trace the exporter itself" requirement.
- **Non-recording spans and `wrapSpanContext`** exist for context-only propagation.

## 4. Gap analysis — logs (Rayfin P1) and metrics (Rayfin P2)

| Area | Catalog symbols | Current state | Work required |
|---|---|---|---|
| **Logs** (§4.2) | `logs.getLogger`, `logger.emit({ severityNumber, severityText, body, attributes })`, `SeverityNumber.*` | ❌ **Entirely absent.** No `@opentelemetry/api-logs` surface; existing `safeGetLogger`/`DiagnosticLogger` is the *internal* diagnostics channel, not OTel logs. | Implement a `LoggerProvider` + `Logger.emit` that maps OTel `LogRecord`s to AI telemetry (trace/message telemetry with severity mapping), stamped with the active trace/span id from the context manager. Register via `logs.setGlobalLoggerProvider`. Depends on `@opentelemetry/api-logs` (still `0.x` upstream — see §7 risk). |
| **Metrics** (§4.3) | `metrics.getMeter`, `createHistogram`, `histogram.record`, `createCounter`, `counter.add`, `createUpDownCounter` | ❌ **Entirely absent.** `metrics?` is commented out in `IOTelApi`. | Implement a `MeterProvider` mapping OTel instruments to AI metric telemetry (`IMetricTelemetry`) with aggregation/attributes-per-record. This is the largest and least-defined body of work; Rayfin flags it as the weakest expected area (their open question #4). Register via `metrics.setGlobalMeterProvider`. |

Rayfin explicitly allows metrics to lag and even to be served by a vanilla OTel `MeterProvider` while AI
owns traces+logs (their §8 Q4). That makes metrics safe to defer to a later phase.

## 5. The critical dependency — async ContextManager (catalog §6.1)

This is the highest-risk, highest-value work item and deserves its own section.

**Problem.** Every Rayfin method is `async`: `rayfin.data.findMany` → `await` → `POST /graphql`. For the
HTTP span to be a *child* of the operation span, `context.active()` must still return the operation
span's context **after the `await`**. That needs a `ContextManager` that survives promise/microtask
boundaries. In the browser this is a known hard problem:

- `StackContextManager` (OTel web) is synchronous-only and does **not** survive `await`.
- `ZoneContextManager` works but pulls in `zone.js` (bundle-size / IE concerns for us).

**Options for AI:**

| Approach | Pros | Cons |
|---|---|---|
| Ship a `StackContextManager`-equivalent (sync) | Small, simple, ES5-friendly | Does **not** parent across `await` — degrades Rayfin's auto-instrumentation & Builder spans |
| Ship a Zone-based manager | Correct across `await` | `zone.js` dependency; ES5 / bundle-size cost; conflicts with Angular zones |
| Investigate `AsyncContext` / microtask-aware manager | Correct, no zone.js | Emerging web API; not universally available; needs polyfill/fallback |

**Mitigation Rayfin already accepts:** because Rayfin controls the whole operation → HTTP call chain, it
will **thread context explicitly** (`trace.setSpan(context.active(), span)` → pass down →
`tracer.startSpan(name, opts, parentCtx)`). This means **the minimum viable slice is a *synchronous*
context manager plus the explicit-parent `startSpan` overload (§3)** — that alone makes *our* spans
correctly parented. A real async manager remains the better long-term outcome because it also fixes
Builder-authored spans and any auto-instrumentation.

**Decision needed (owner: AI team):** commit to at least a synchronous `ContextManager` + explicit
context objects for P0, and schedule an async manager investigation. Document the behaviour explicitly
so Rayfin can rely on the explicit-threading path (their open question #2).

## 6. Cross-cutting requirements

| Requirement | Catalog ref | Current state | Work |
|---|---|---|---|
| **No-op when no provider registered** | §6.2 | ✅ if Option A — `@opentelemetry/api` guarantees no-op when nothing is registered. | Add validation tests confirming zero output/overhead pre-registration. |
| **PII redaction** — strip `url.full` query string; never record `Authorization` / `X-Publishable-Key`; no emails/OIDs/tokens | §6.3 | ⚠️ No documented redaction hook for OTel spans/attributes. | Provide a supported **attribute/URL redaction hook** (e.g. a config callback applied before export) and document it. Answers Rayfin open question #6. Ensure default URL capture strips query strings. |
| **Isomorphic (browser + Node)** | §6.4 | ⚠️ AISKU is browser-focused. | Confirm the API-only dependency does not drag browser-only code into Node bundles; document the Node story (or state browser-only explicitly). Answers Rayfin open question #8. |
| **Don't trace the exporter** | §6.5 | ✅ `suppressTracing` / `isTracingSuppressed` already exist. | Confirm the exporter/channel HTTP path runs under tracing suppression; add a test. Answers Rayfin open question #7. |

## 7. Risks & open questions

1. **Async context propagation across `await`** — the make-or-break item (§5). Without at least the
   sync-manager + explicit-parent path, traces arrive unparented and lose most of their value.
2. **`@opentelemetry/api-logs` is `0.x`** — depending on an unstable façade for logs. Mitigation Rayfin
   offers: route diagnostics as span events until it stabilizes (requires §3 `addEvent` work anyway).
3. **Metrics model completeness** — Histogram / Counter / UpDownCounter / explicit buckets /
   attributes-per-record is a large surface and the weakest-defined; safe to defer (Rayfin §8 Q4).
4. **ES5 / bundle-size constraints** — the bridge and any context manager must honour the repo's ES5
   target and tree-shaking rules (no `?.`, no `??`, `dynamicProto` pattern, side-effect-free modules).
5. **Bundle isolation** — `@opentelemetry/api` and `@opentelemetry/api-logs` must be **peer
   dependencies** of the bridge, never hard deps of core, to avoid version conflicts with Rayfin/host.
6. **`addEvent` telemetry mapping** — decide how span events surface in AI (custom properties on the
   span telemetry vs. separate message telemetry).

## 8. Proposed phasing

Mirrors Rayfin's own P0 → P1 → P2 order. Phase 1 alone is a useful milestone for Rayfin.

### Phase 1 — Traces + context + propagation (Rayfin P0)
- New **OTel provider bridge** package (Option A) with `@opentelemetry/api` as a peer dep.
- Adapt internal tracer/span to official `Tracer`/`Span`; map `SpanKind` / `SpanStatusCode`.
- **Explicit-parent `startSpan(name, options, context)` overload** + OTel `Context` abstraction +
  `trace.setSpan` / `trace.getSpan` / `trace.getActiveSpan`.
- **Synchronous `ContextManager`** registered via `context.setGlobalContextManager` (async manager
  spun out as investigation).
- **W3C `TextMapPropagator`** (`propagation.inject`/`extract`) built on existing W3C primitives,
  registered via `propagation.setGlobalPropagator`.
- **`span.addEvent` implementation** (needed for retry/token-refresh/timeout events).
- **URL/attribute redaction hook** + default query-string stripping (§6.3).
- Confirm exporter self-tracing suppression (§6.5).
- Tests: no-op-when-unregistered, explicit-parent threading, `traceparent` injection, redaction.

### Phase 2 — Logs (Rayfin P1)
- `LoggerProvider` + `Logger.emit` mapping OTel `LogRecord` → AI telemetry with severity mapping and
  active trace/span-id stamping; register via `logs.setGlobalLoggerProvider`.
- `@opentelemetry/api-logs` as a peer dep; document its `0.x` status.

### Phase 3 — Metrics (Rayfin P2)
- `MeterProvider` with Histogram / Counter / UpDownCounter, attributes-per-record, mapping to AI metric
  telemetry. Confirm `error.type`-as-histogram-attribute pattern (Rayfin open question #5).
- Coordinate with Rayfin on the "vanilla MeterProvider for metrics only" fallback if this slips.

## 8.1 Rough effort estimation

Sizing is **relative effort/complexity**, not calendar time. T-shirt scale:
**S** = small/contained, **M** = moderate (design + impl + tests), **L** = large (cross-cutting or
new subsystem), **XL** = large + high uncertainty / research needed. "Confidence" reflects how well the
shape is understood today.

### Phase 1 — Traces (Rayfin P0)

| Work item | Size | Confidence | Notes |
|---|---|---|---|
| Bridge package scaffolding (peer deps, rollup/rush/api-extractor wiring, ES5 build) | M | High | Follows existing package patterns in the monorepo. |
| Adapt internal tracer/span → official `Tracer`/`Span`; map `SpanKind`/`SpanStatusCode` | M | High | Thin wrappers; enums already align with OTel. |
| Explicit-parent `startSpan(name, opts, context)` + OTel `Context` abstraction + `trace.setSpan/getSpan/getActiveSpan` | L | Medium | New context object type; `createSpan(parent)` plumbing already exists internally. |
| Synchronous `ContextManager` + global registration | M | Medium | Straightforward; the *async* variant is the risky part (below). |
| `span.addEvent` implementation + telemetry mapping | M–L | Medium | Requires deciding how events surface in AI telemetry. |
| W3C `TextMapPropagator` (inject/extract) + registration | M | High | Builds on existing `createTraceParent`/`parseTraceParent` primitives. |
| URL/attribute redaction hook + default query-string stripping | M | Medium | New config surface; must be documented and tested for PII (§6.3). |
| Confirm exporter self-tracing suppression + test | S | High | `suppressTracing` already exists. |
| No-op / registration / threading / injection / redaction tests | L | Medium | Broad surface; must follow `AITestClass` + dynamic-config test conventions. |
| **Phase 1 subtotal** | **~L–XL** | **Medium** | Deliverable, useful milestone on its own. |

### Async ContextManager (parallel research track — see §5)

| Work item | Size | Confidence | Notes |
|---|---|---|---|
| Async context manager that survives `await` (Zone-based vs. microtask/`AsyncContext`) | L–XL | **Low** | Highest-risk item; bundle-size/ES5/zone.js trade-offs. Rayfin's explicit-threading mitigation means P0 is *not blocked* on this. |

### Phase 2 — Logs (Rayfin P1)

| Work item | Size | Confidence | Notes |
|---|---|---|---|
| `LoggerProvider` + `Logger.emit` → AI telemetry, severity mapping, trace/span-id stamping | M–L | Medium | Depends on active context manager for correlation. |
| `@opentelemetry/api-logs` peer dep + `0.x` volatility handling | S | Medium | Upstream façade still unstable. |
| Tests (emit, severity mapping, correlation, no-op) | M | Medium | |
| **Phase 2 subtotal** | **~M–L** | **Medium** | |

### Phase 3 — Metrics (Rayfin P2)

| Work item | Size | Confidence | Notes |
|---|---|---|---|
| `MeterProvider` + Histogram / Counter / UpDownCounter, attributes-per-record, AI metric mapping | L–XL | **Low** | Largest, least-defined surface; Rayfin's weakest-expected area. |
| Aggregation / bucket-boundary semantics + `error.type` attribute pattern | M–L | Low | Rayfin open question #5. |
| Tests | M–L | Low | |
| **Phase 3 subtotal** | **~XL** | **Low** | Deferrable; vanilla-OTel `MeterProvider` fallback acceptable to Rayfin. |

### Overall shape

| Phase | Aggregate size | Risk driver |
|---|---|---|
| Phase 1 (P0 traces) | **L–XL** | Explicit-context abstraction + `addEvent` + redaction |
| Async ContextManager (parallel) | **L–XL** | Browser async-context is an unsolved-in-general problem |
| Phase 2 (P1 logs) | **M–L** | `api-logs` `0.x` instability |
| Phase 3 (P2 metrics) | **XL** | Full Meter model mapping; deferrable |

**Biggest unknowns to resolve before committing dates:** (1) the async context-manager approach, and
(2) the metrics aggregation model. Both are isolated enough to de-risk with a short spike each without
blocking the Phase 1 traces milestone.

## 9. Answers we can give Rayfin today (their §8 open questions)

| # | Question | Answer from current codebase |
|---|---|---|
| 1 | Which signals in first drop? | **Traces** — the span surface exists today; **logs and metrics are not yet implemented.** Traces-only first drop is aligned. |
| 2 | Which context manager, survives `await`? | **None registered today.** Plan: ship a synchronous manager + explicit-parent `startSpan` for P0; async manager under investigation. Rayfin's explicit-threading mitigation is supported by the planned `startSpan(name, opts, context)` overload. |
| 3 | W3C propagator registered by default? | **Not yet**, but W3C primitives exist; a `W3CTraceContextPropagator` is planned for Phase 1 so `propagation.inject()` emits a standard `traceparent`. |
| 4 | MeterProvider model completeness? | **Not implemented yet** (Phase 3). Metrics-only-via-vanilla-OTel split is acceptable to us. |
| 5 | `error.type` as histogram attribute? | To be confirmed during Phase 3 metrics design. |
| 6 | Redaction hook for URLs/headers? | Not documented today; a redaction hook + default query-string stripping is a Phase 1 deliverable. |
| 7 | Exporter protected from self-tracing? | **Yes** — `suppressTracing` / `isTracingSuppressed` exist; we will add a confirming test. |
| 8 | Browser-only or Node story? | AISKU is browser-focused today; API-only dependency should resolve cleanly for Node. Node path to be confirmed/documented. |

## 10. Source references (current implementation)

| Area | Path |
|---|---|
| OTel API entry interface | [shared/AppInsightsCore/src/interfaces/otel/IOTelApi.ts](../../shared/AppInsightsCore/src/interfaces/otel/IOTelApi.ts) |
| Trace API (getTracer, getActiveSpan, setActiveSpan) | [shared/AppInsightsCore/src/interfaces/otel/trace/IOTelTraceApi.ts](../../shared/AppInsightsCore/src/interfaces/otel/trace/IOTelTraceApi.ts) |
| Tracer interface (startSpan/startActiveSpan) | [shared/AppInsightsCore/src/interfaces/otel/trace/IOTelTracer.ts](../../shared/AppInsightsCore/src/interfaces/otel/trace/IOTelTracer.ts) |
| Span interface (addEvent/addLink commented out) | [shared/AppInsightsCore/src/interfaces/otel/trace/IOTelSpan.ts](../../shared/AppInsightsCore/src/interfaces/otel/trace/IOTelSpan.ts) |
| Trace provider / host (createSpan with parent) | [shared/AppInsightsCore/src/interfaces/ai/ITraceProvider.ts](../../shared/AppInsightsCore/src/interfaces/ai/ITraceProvider.ts) |
| SpanKind / SpanStatus enums | [shared/AppInsightsCore/src/enums/otel/OTelSpanKind.ts](../../shared/AppInsightsCore/src/enums/otel/OTelSpanKind.ts), [OTelSpanStatus.ts](../../shared/AppInsightsCore/src/enums/otel/OTelSpanStatus.ts) |
| Semantic convention constants | [shared/AppInsightsCore/src/otel/attribute/SemanticConventions.ts](../../shared/AppInsightsCore/src/otel/attribute/SemanticConventions.ts) |
| W3C trace-parent primitives | [shared/AppInsightsCommon/src/applicationinsights-common.ts](../../shared/AppInsightsCommon/src/applicationinsights-common.ts) |
| Existing OTel tracing docs | [docs/OTel/README.md](./README.md) |
