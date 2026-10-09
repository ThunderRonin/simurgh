# Simurgh

Simurgh connects what a person selects and asks about to the evidence their existing AI agent needs to investigate it. This glossary defines product language; behavior and architecture are specified in [DESIGN.md](DESIGN.md).

## Language

### Intent and reference

**Surface**:
An application view in which a person can indicate something they want to discuss, such as a dashboard or source editor.

**Selection**:
A person's indication of an area, object, series, interval, or source range. A selection expresses attention but does not yet establish an unambiguous target or authorize an investigation.
_Avoid_: Confirmed target, permission grant

**Target candidate**:
A proposed interpretation of a selection, including the identified object, scope, and relevant time or source version. A selection may produce multiple candidates or no resolvable candidate.

**Confirmed target**:
A target candidate the person has explicitly accepted as the object and scope of their question. Confirmation establishes intent; it does not expand their access rights or authorize changes to the underlying system.
_Avoid_: Root cause, execution approval

**Target snapshot**:
The captured state that makes a target reproducible, including its identity, applicable filters or source range, observation time, and data or document version. A snapshot is not a continuously changing pointer to whatever is currently on screen.

**Pinned reference**:
A visible attachment that preserves a confirmed target for subsequent questions. Multiple pinned references can be discussed together without implying that they are causally related.

**Question**:
The person's request concerning one or more targets, expressed through speech or text. The selection identifies what is being discussed; the question identifies what the person wants to understand.

### Investigation and evidence

**Investigation**:
A bounded attempt to answer a question about confirmed targets using authorized evidence. An investigation can legitimately finish without identifying a cause.

**Evidence item**:
An attributable observation used in an investigation, with its source, scope, relevant time or version, and known limitations. A model-generated explanation is not itself an evidence item.
_Avoid_: Proof, root cause

**Evidence bundle**:
The bounded collection of target snapshots, evidence items, and coverage limitations supplied for reasoning about a question. It is not an unrestricted dump of a dashboard, repository, or logging system.

**Hypothesis**:
A possible explanation with stated supporting evidence, opposing evidence, and a check that could strengthen or weaken it. A plausible hypothesis is not a confirmed cause.

**Runtime-to-code link**:
Evidence connecting an observed operation or resource-consumption sample to a source location and relevant deployed version. Merely sharing a timestamp, function name, or repository does not establish this link.

**Finding**:
The investigation's answer, classified by what its evidence supports: a supported explanation, a tentative hypothesis, or an inconclusive result. Its evidence strength is separate from whether the investigation stopped normally, was cancelled, or exhausted its budget.

**Evidence gap**:
An identified absence or limitation that prevents a particular conclusion, such as missing profiles, truncated logs, uncertain time resolution, or an unknown deployed revision.

### Collaboration and control

**Agent host**:
The user's existing coding or general-purpose AI environment through which an investigation is performed. Simurgh adds grounded context and investigation controls rather than replacing that environment's general reasoning role.

**Investigation budget**:
The limits governing the investigation's time, model usage, and evidence retrieval. A budget describes permitted work, not a promise that a cause will be found within it.

**Investigation scope**:
The permitted targets, identities, time ranges, source revisions, and evidence sources for a particular question. It can be narrower than everything the person is authorized to access.
