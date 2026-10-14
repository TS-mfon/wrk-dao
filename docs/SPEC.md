# WRK DAO

## Autonomous Work DAOs for On-Chain Agents

### Master Implementation Specification

---

# 1. PRODUCT DEFINITION

## 1.1 Core concept

WRK is an **agent-native work protocol** where autonomous agents can create, operate, join, and work inside decentralized Work DAOs.

A Work DAO is not simply a job board.

A Work DAO is an autonomous organization created by an agent for a specific purpose.

The DAO has:

* a unique DAO ID
* creator/owner agent
* DAO name
* description
* purpose
* operating rules
* accepted capabilities
* treasury
* jobs/missions
* proposals
* worker agents
* mandates
* work history
* DAO-specific reputation
* GenLayer decisions
* disputes
* settlement history

The fundamental lifecycle is:

```text
Agent creates DAO
        ↓
DAO is registered
        ↓
Creator funds DAO treasury / escrow
        ↓
Creator publishes a Mission
        ↓
Worker Agents discover Mission
        ↓
Worker Agents submit Proposals
        ↓
GenLayer evaluates proposals
        ↓
GenLayer selects work arrangement
        ↓
Mandate is created
        ↓
Funds are locked in Base escrow
        ↓
Worker Agent/team executes work
        ↓
Worker submits deliverables + evidence
        ↓
GenLayer reviews completed work
        ↓
GenLayer finalizes adjudication
        ↓
Settlement instruction is produced
        ↓
Base escrow releases/refunds/partially settles
        ↓
DAO reputation/history is updated
```

### Absolute payment rule

**No agent is paid when submitting a proposal.**

A proposal is only an application/work offer.

No proposal creates an entitlement to funds.

Payment becomes possible only after:

1. the proposal has been selected;
2. a mandate has been created;
3. the required work has been submitted;
4. the evidence has been submitted;
5. GenLayer has reviewed the work;
6. the adjudication reaches the required final state;
7. the settlement instruction is executed against the Base escrow.

---

# 2. PRODUCT PHILOSOPHY

WRK should be designed around five principles.

## Principle 1 — DAO first

Everything belongs to a DAO.

A job is not an independent marketplace listing.

It is a DAO mission.

A proposal is not an independent application.

It is a proposal to participate in that DAO's mission.

A worker reputation is not merely global.

It is primarily evaluated in the context of DAO work.

---

## Principle 2 — Agents operate, humans inspect

The normal workflow must not require humans.

Agents interact through:

* SDK
* API
* MCP
* agent skills
* machine-readable schemas

The web UI is primarily for:

* inspection
* monitoring
* discovery
* analytics
* transaction history
* GenLayer decisions
* treasury visibility
* DAO activity

The UI should not be required for:

* submitting jobs
* applying
* accepting mandates
* submitting work
* submitting evidence
* triggering normal settlement

---

## Principle 3 — GenLayer is the judgment layer

Do not reduce GenLayer to a simple "AI reviewer."

GenLayer should govern decisions requiring interpretation:

* mission validation
* proposal evaluation
* capability matching
* work-arrangement selection
* evidence evaluation
* deliverable evaluation
* acceptance criteria
* partial completion
* rejection
* dispute adjudication
* reputation outcome

GenLayer's Optimistic Democracy is specifically designed around a proposed execution result being independently evaluated by validators, with finality after the relevant process/appeal window.

---

## Principle 4 — Base is the economic settlement layer

Base holds the actual USDC escrow.

GenLayer decides what should happen.

Base executes the economic result.

Conceptually:

```text
GenLayer:
"Worker completed 100% of the mandate."

        ↓

Settlement instruction

        ↓

Base Escrow:
release 500 USDC
```

Or:

```text
GenLayer:
"Worker completed 60%."

        ↓

Settlement instruction

        ↓

Base:
release 300 USDC
refund 200 USDC
```

Or:

```text
GenLayer:
"Work failed."

        ↓

Settlement instruction

        ↓

Base:
refund escrow
```

---

## Principle 5 — Evidence is part of the work

A worker cannot simply say:

> "I completed the job."

The mandate specifies what evidence is required.

Example:

```text
Deliverable:
Research report

Evidence:
- source URLs
- repository commit
- generated report hash
- execution metadata
- referenced datasets
- timestamps
```

GenLayer evaluates the evidence against the mandate.

---

# 3. WHAT A WORK DAO IS

Every Work DAO is an autonomous organization.

Example:

```text
DAO ID:
WRK-DAO-000001

Name:
Protocol Intelligence DAO

Creator:
0xABC...

Description:
Autonomous research organization for blockchain
protocol intelligence.

Purpose:
Discover, commission and verify research work
performed by autonomous agents.

Rules:
- Work must satisfy mandate requirements.
- Payment requires finalized GenLayer adjudication.
- Proposals are unpaid.
- DAO treasury can only fund approved mandates.
- Worker reputation is updated after finalized work.

Accepted capabilities:
- blockchain research
- protocol analysis
- web research
- data analysis
```

---

# 4. DAO DATA MODEL

The DAO must have a canonical on-chain identity.

## DAO

```text
dao_id
dao_address
creator_agent
name
slug
description
purpose
rules_hash
metadata_uri
metadata_hash

created_at
updated_at

status

treasury_address
escrow_address

accepted_capabilities
supported_work_types

membership_policy
proposal_policy
selection_policy
payment_policy
dispute_policy
reputation_policy

total_members
total_jobs
total_completed_jobs
total_disputed_jobs
total_value_settled
```

---

# 5. DAO IDENTITY

Each DAO receives a permanent identifier.

Example:

```text
dao_id = 0x...unique...
```

The ID should never depend on the UI database.

The canonical DAO ID should be derived from on-chain registration.

The frontend/API can maintain an indexed representation, but the protocol's canonical identity must come from the contracts.

Recommended:

```text
DAO Registry
    ↓
DAO ID
    ↓
DAO contract/configuration
```

---

# 6. DAO CREATOR

Every DAO has a creator agent.

```text
creator_agent
```

The creator is the DAO's initiating operator.

But the creator does not have unlimited authority over money or adjudication.

The creator can:

* create DAO
* configure DAO rules
* publish missions
* fund treasury
* pause new work
* update permitted policies within governance limits

The creator cannot:

* directly steal escrowed worker funds
* mark work completed without GenLayer
* force payment without adjudication
* override finalized adjudication
* arbitrarily alter a live mandate
* change the worker after execution has started

This separation is critical.

---

# 7. DAO MEMBERSHIP

An agent can become associated with a DAO through work participation.

Potential membership states:

```text
DISCOVERED
    ↓
APPLIED
    ↓
SELECTED
    ↓
WORKER
    ↓
TRUSTED_WORKER
    ↓
INACTIVE
```

The DAO should record work history even if the agent is no longer active.

---

# 8. DAO REPUTATION

Do not make reputation simply:

```text
score = 95
```

Store the underlying facts.

Example:

```text
Agent A

DAO:
Protocol Intelligence DAO

Jobs completed:
18

Accepted:
16

Partial:
1

Rejected:
1

Disputed:
0

Total value earned:
4,200 USDC

Average delivery time:
...

Capabilities:
research
analysis
monitoring
```

Then GenLayer can interpret those facts when evaluating future proposals.

This creates **DAO-specific professional reputation**.

---

# 9. GLOBAL VS DAO REPUTATION

The system should eventually support both.

### DAO reputation

How the agent performed inside a specific DAO.

### Network reputation

Aggregated historical performance across WRK.

But DAO reputation should be the primary input for DAO-specific hiring.

A security agent might be excellent inside a security DAO but have no meaningful history in a research DAO.

The protocol should not blindly treat those as identical.

---

# 10. DAO TREASURY

Each DAO has a treasury.

The treasury is not automatically the same thing as active job escrow.

Use:

```text
DAO Treasury
       │
       │ funds mandate
       ▼
Base Escrow
       │
       │ locked
       ▼
Mandate
```

The treasury can hold available funds.

When a mission is approved for execution:

```text
Treasury
   ↓
Escrow funding
   ↓
Mandate
```

Once funds enter an active mandate escrow, they become governed by that mandate's settlement rules.

---

# 11. BASE ESCROW

Use a dedicated Base smart contract.

Conceptual contract:

```text
WRKEscrow.sol
```

Responsibilities:

* receive USDC
* lock USDC against mandate IDs
* maintain escrow balances
* prevent premature withdrawal
* accept authorized settlement instructions
* release worker payment
* refund creator
* support partial settlement
* prevent double settlement
* emit settlement events

The escrow should never ask:

> "Was the work good?"

That is not its responsibility.

It only asks:

> "Is there a valid finalized settlement instruction for this mandate?"

---

# 12. ESCROW STATES

```text
UNFUNDED
   ↓
FUNDED
   ↓
LOCKED
   ↓
WORK_IN_PROGRESS
   ↓
SUBMITTED
   ↓
UNDER_REVIEW
   ↓
AWAITING_FINALITY
   ↓
SETTLEMENT_READY
   ↓
SETTLED
```

Failure path:

```text
UNDER_REVIEW
      ↓
REJECTED
      ↓
REFUND_READY
      ↓
SETTLED
```

Partial path:

```text
UNDER_REVIEW
      ↓
PARTIAL_ACCEPTANCE
      ↓
SETTLEMENT_READY
      ↓
PARTIAL_SETTLEMENT
```

---

# 13. PAYMENT MODEL

For the initial version, use USDC on Base.

Every mandate contains:

```text
gross_budget
platform_fee
worker_amount
possible_refund
```

Recommended protocol model:

```text
Mission budget:
500 USDC

Protocol fee:
configurable percentage

Worker payment:
determined by finalized adjudication

Refund:
remaining amount
```

Do not hard-code the protocol fee into every contract.

Create protocol configuration:

```text
protocol_fee_bps
```

Example initial configuration:

```text
250 bps = 2.5%
```

But make this a deploy/configuration parameter rather than an immutable assumption.

---

# 14. WHEN THE FEE IS CHARGED

The protocol fee should not be charged when an agent submits a proposal.

Proposal:

```text
FREE
```

When the mission is funded:

```text
creator funds escrow
```

The final settlement determines the fee accounting.

Example:

```text
Mission:
500 USDC

Protocol fee:
12.50 USDC

Worker:
487.50 USDC
```

For partial settlement:

```text
500 USDC escrow

GenLayer result:
60% accepted

Gross worker amount:
300 USDC

Protocol fee:
calculated according to protocol rules

Refund:
remaining eligible amount
```

The exact accounting should be deterministic in the settlement contract.

---

# 15. IMPORTANT: GENLAYER FEES ARE DIFFERENT

There are two separate economic systems.

### WRK economic fee

The protocol fee charged by WRK.

### GenLayer transaction/protocol fees

Fees required to execute GenLayer transactions and consensus.

Do not mix them.

Current GenLayer documentation requires fee-aware deployment/writes and recommends measuring and committing fee profiles for the relevant methods.

The application should therefore maintain:

```text
WRK business fee
+
GenLayer execution fee
+
Base gas
```

as separate accounting concepts.

---

# 16. THE MODEL 2 MISSION

The core unit is not called merely a "job."

Call it:

```text
MISSION
```

A mission describes an outcome.

Example:

```text
Mission:

"Maintain reliable intelligence on Protocol X
for the next seven days."
```

The creator defines the outcome but does not necessarily prescribe exactly how the worker must perform it.

This is the key difference between Model 1 and Model 2.

---

# 17. MISSION DATA MODEL

```text
mission_id
dao_id
creator_agent

title
description
objective
purpose

required_outcomes
required_capabilities

constraints

budget
currency

deadline
submission_deadline

acceptance_criteria

evidence_requirements

proposal_deadline

selection_method

team_allowed

max_workers

work_policy

dispute_policy

metadata_uri
metadata_hash

status

created_at
updated_at
```

---

# 18. MISSION STATUS

```text
DRAFT
    ↓
PUBLISHED
    ↓
PROPOSALS_OPEN
    ↓
PROPOSALS_CLOSED
    ↓
UNDER_SELECTION
    ↓
SELECTED
    ↓
MANDATE_PENDING
    ↓
FUNDED
    ↓
EXECUTING
    ↓
SUBMITTED
    ↓
UNDER_ADJUDICATION
    ↓
FINALIZED
    ↓
SETTLED
```

Alternative:

```text
PROPOSALS_OPEN
      ↓
CANCELLED
```

or:

```text
UNDER_ADJUDICATION
      ↓
DISPUTED
      ↓
FINALIZED
```

---

# 19. AGENT PROPOSALS

The proposal is the heart of Model 2.

An agent should not simply submit:

```text
"I can do it."
```

It submits a structured work strategy.

---

## Proposal schema

```text
proposal_id

mission_id
dao_id

agent_id

capabilities

experience_summary

proposed_strategy

execution_plan

deliverables

evidence_plan

estimated_duration

requested_budget

team_members

dependencies

tools_required

risk_assessment

availability

previous_relevant_work

metadata_uri
metadata_hash

submitted_at
status
```

---

# 20. CAPABILITY SYSTEM

Agents need machine-readable capabilities.

Example:

```text
capabilities:

research
web-research
defi-analysis
smart-contract-analysis
data-analysis
coding
security-analysis
monitoring
report-generation
verification
```

But capabilities should not just be text strings.

Each capability can have:

```text
capability_id
name
description
version
evidence
```

An agent can declare:

```text
Agent A

Capabilities:
- protocol-analysis
- web-research
- onchain-analysis
```

GenLayer can evaluate whether the proposal actually demonstrates those capabilities.

---

# 21. PROPOSAL SELECTION

When proposals close:

```text
Proposal A
Proposal B
Proposal C
Proposal D
```

the DAO creates a **Selection Adjudication**.

GenLayer receives:

```text
Mission
+
DAO rules
+
Proposal set
+
Agent capability information
+
Relevant DAO work history
+
Budget constraints
```

The adjudication prompt must instruct GenLayer to:

1. understand the mission;
2. identify required outcomes;
3. inspect each proposal;
4. inspect capabilities;
5. inspect relevant historical performance;
6. identify strengths and weaknesses;
7. identify conflicts;
8. determine which proposal or team arrangement best satisfies the mission;
9. produce a structured decision;
10. explain the decision;
11. produce machine-readable selected agent/team IDs.

---

# 22. DO NOT MAKE GENLAYER RETURN ONLY TEXT

The adjudication result needs a deterministic structured representation.

Example:

```text
SelectionDecision:

status:
SELECTED

selected_agents:
[
  0x123...
]

allocation:
[
  {
    agent: 0x123,
    responsibility: "research",
    allocation: 300
  }
]

rejected_proposals:
[...]

reasoning_hash:
0x...

decision_hash:
0x...

mission_id:
...

timestamp:
...
```

The human-readable reasoning can be stored separately.

The protocol acts on the structured decision.

---

# 23. SINGLE AGENT OR TEAM

Model 2 must support both.

### Single agent

```text
Mission
   ↓
Agent A
```

### Multi-agent team

```text
Mission
   ↓
Agent A — research
Agent B — data
Agent C — verification
```

The proposal can therefore contain:

```text
team_members[]
```

The selected team becomes the **mandate workforce**.

---

# 24. TEAM ALLOCATION

Example:

```text
Mission budget:
1,000 USDC

Selected:

Research Agent:
400

Data Agent:
300

Verification Agent:
300
```

The escrow still contains:

```text
1,000 USDC
```

but the mandate defines the internal allocation.

No one receives payment until the work is adjudicated.

---

# 25. MANDATE

After GenLayer selects the work arrangement, the protocol creates a Mandate.

The Mandate is the actual execution agreement.

```text
MANDATE

mandate_id
dao_id
mission_id

creator
workers[]

objective

deliverables
responsibilities

budget
allocations

deadline

acceptance_criteria
evidence_requirements

settlement_policy
dispute_policy

proposal_hash
selection_decision_hash

status
```

The mandate should be immutable once execution begins except for explicitly supported state transitions.

---

# 26. MANDATE ACCEPTANCE

Selected agents must accept the mandate.

```text
SELECTED
    ↓
MANDATE_CREATED
    ↓
WORKER_ACCEPTS
    ↓
MANDATE_ACTIVE
```

Acceptance confirms:

* worker identity
* worker wallet
* responsibilities
* budget
* deadline
* evidence requirements

No payment occurs.

---

# 27. FUNDING

The creator/DAO funds the mandate.

```text
DAO Treasury
      ↓
Base Escrow
      ↓
mandate_id
      ↓
locked USDC
```

The escrow contract records:

```text
mandate_id
dao
creator
workers
amount
token
deadline
status
```

The worker cannot withdraw this money.

The creator cannot arbitrarily withdraw it once the mandate becomes active.

---

# 28. EXECUTION

The worker performs work outside the chain.

The chain should not attempt to execute every piece of work.

Instead, the worker produces:

```text
deliverables
+
evidence
+
metadata
```

Examples:

```text
GitHub repository
commit hash
API response
research report
dataset
transaction references
screenshots
URLs
execution logs
content hashes
```

The protocol records references/hashes rather than attempting to store huge artifacts directly on-chain.

---

# 29. EVIDENCE MODEL

Create a standard evidence object.

```text
Evidence:

evidence_id
mandate_id
worker
type
uri
content_hash
mime_type
created_at
description
```

Example:

```text
type:
github_commit

uri:
repository/commit/abc123

content_hash:
0x...

description:
Implementation of the requested monitoring module.
```

The MVP can support HTTPS/GitHub-based evidence plus hashes. Do not make IPFS a requirement for the first version.

---

# 30. WORK SUBMISSION

The worker calls:

```text
wrk.submitWork(mandateId, submission)
```

Submission contains:

```text
deliverables[]
evidence[]
completion_statement
worker_metadata
```

This creates:

```text
SUBMITTED
```

No payment happens here.

---

# 31. GENLAYER WORK ADJUDICATION

This is the second major GenLayer operation.

GenLayer receives:

```text
Mandate
+
Original mission
+
Selected proposal
+
Acceptance criteria
+
Submitted deliverables
+
Evidence
```

It must answer:

```text
Was the agreed work completed?

Which requirements were satisfied?

Which were not?

Does the evidence support the claims?

Was the work delivered within the deadline?

Is partial completion justified?

Should payment be:

FULL
PARTIAL
ZERO
```

---

# 32. ADJUDICATION OUTPUT

Use structured results.

```text
WorkDecision:

decision:
FULL_ACCEPTANCE

completion_percentage:
100

worker_results:
[
  {
    worker: 0x123,
    completion: 100,
    payment_bps: 10000
  }
]

accepted_deliverables:
[...]

failed_requirements:
[...]

evidence_assessment:
[...]

reasoning_hash:
...

decision_hash:
...

mandate_id:
...
```

Possible decisions:

```text
FULL_ACCEPTANCE
PARTIAL_ACCEPTANCE
REJECTION
```

---

# 33. NO PAYMENT BEFORE FINAL ADJUDICATION

This should be a hard invariant.

The Base escrow must reject settlement unless:

```text
finalizedDecision == true
```

and:

```text
mandate.status == SETTLEMENT_READY
```

and:

```text
settlement_id has not been consumed
```

Therefore:

```text
Proposal
    → $0

Mandate creation
    → $0

Mandate acceptance
    → $0

Work submission
    → $0

GenLayer accepted
    → still $0 until finality

Finalized adjudication
    → settlement becomes executable

Base settlement
    → payment
```

---

# 34. FINALITY

Do not use an "accepted" GenLayer result as the financial trigger.

The financial trigger must be based on the required **finalized** outcome.

Current GenLayer documentation specifically warns that accepted-stage messages can later be invalidated by an appeal, while external EVM messages are restricted to finalized execution.

This is exactly why the architecture should wait for finality before Base settlement.

---

# 35. BASE SETTLEMENT ARCHITECTURE

There is one important cross-chain engineering issue.

GenLayer's documented external-message mechanism crosses from GenVM to the GenLayer Chain EVM layer. It does not mean an Intelligent Contract can magically execute a transaction directly on Base.

Therefore the architecture must have a **Base Settlement Adapter**.

Conceptually:

```text
GenLayer
   │
   │ finalized adjudication
   ▼
Settlement Decision
   │
   ▼
Settlement Adapter
   │
   │ verified final decision
   ▼
Base Escrow
   │
   ├── release
   ├── partial release
   └── refund
```

The adapter is an executor, not an adjudicator.

It must never be able to invent:

```text
"pay worker 500 USDC"
```

on its own.

It should only execute a settlement whose decision can be verified against the finalized GenLayer result.

---

# 36. SETTLEMENT ADAPTER DESIGN

Create an abstraction:

```text
SettlementAdapter
```

Responsibilities:

```text
watch finalized GenLayer decisions
verify decision identity
verify mandate ID
verify decision hash
verify settlement nonce
construct Base settlement transaction
submit transaction
wait for confirmation
report transaction hash
```

The adapter should be stateless wherever possible.

Maintain:

```text
processed_decision_ids
```

to prevent replay.

---

# 37. CROSS-CHAIN SECURITY

Do not use:

```text
Backend says:
"GenLayer approved it."
```

as the only security mechanism.

The Base escrow needs a verifiable authorization model.

The final production architecture should use the supported GenLayer-to-Base verification/bridge mechanism available for the target deployment.

Until that mechanism is verified against the current production infrastructure, keep the settlement adapter behind an explicit interface:

```text
IGenLayerSettlementVerifier
```

Possible implementation:

```text
GenLayerFinalityVerifier
```

Then the Base escrow only accepts:

```text
verifiedDecision
```

not arbitrary backend instructions.

---

# 38. ESCROW CONTRACT INTERFACE

Conceptually:

```solidity
interface IWRKEscrow {

    function createEscrow(
        bytes32 mandateId,
        address dao,
        address creator,
        uint256 amount,
        uint256 deadline
    ) external;

    function fundEscrow(
        bytes32 mandateId,
        uint256 amount
    ) external;

    function finalizeSettlement(
        Settlement calldata settlement
    ) external;

    function getEscrow(
        bytes32 mandateId
    ) external view returns (...);

    function isSettled(
        bytes32 mandateId
    ) external view returns (bool);
}
```

Do not allow:

```text
creator → releaseFunds()
```

That would violate the core model.

---

# 39. SETTLEMENT OBJECT

Use:

```text
Settlement:

mandateId
daoId
decisionId

decisionHash

workerPayments[]
refundAmount

protocolFee

totalAmount

nonce

finalizedAt

verificationData
```

The contract verifies:

```text
total worker payments
+
refund
+
protocol fee
==
escrow balance
```

No money disappears.

---

# 40. REPLAY PROTECTION

Every settlement needs a unique ID.

Example:

```text
settlement_id =
hash(
    mandate_id,
    decision_hash,
    nonce
)
```

Base escrow maintains:

```text
settlementConsumed[settlementId]
```

If already consumed:

```text
REVERT
```

---

# 41. DISPUTES

Model 2 needs an explicit dispute path.

Worker or DAO may challenge a work decision if the protocol rules permit.

But the dispute should still be machine-operable.

```text
Work submitted
      ↓
GenLayer adjudication
      ↓
Initial decision
      ↓
Appeal window
      ↓
Final decision
```

The appeal/finality mechanism must follow GenLayer's actual protocol rather than inventing a second unrelated human arbitration system. GenLayer documents an appeal process that can trigger a larger validator evaluation.

---

# 42. DAO RULES

When a DAO is created, its rules become part of the DAO configuration.

Example:

```text
DAO Rules:

1. All work must be submitted before deadline.
2. Worker proposals are unpaid.
3. Work must include evidence.
4. Payment requires finalized GenLayer adjudication.
5. Partial completion may receive partial settlement.
6. Escrow cannot be withdrawn while a mandate is active.
7. Disputes follow GenLayer adjudication/finality rules.
8. Reputation is updated only after final settlement.
```

Rules should be versioned.

```text
rules_version: 1
rules_hash: 0x...
```

If rules change:

```text
version 2
```

Future missions use the new rules.

Existing mandates remain bound to their original rules.

---

# 43. DAO GOVERNANCE

This is still a DAO, but do not force every operational decision into token voting.

The DAO's governance is encoded through:

* creator permissions
* membership rules
* mission rules
* proposal rules
* selection policy
* adjudication policy
* treasury policy
* dispute policy
* reputation policy

The creator can configure these when creating the DAO.

Future versions can introduce member governance.

The MVP should not add token voting simply because the word DAO appears in the product.

The DAO's important property is **programmable collective operation**, not necessarily speculative governance tokens.

---

# 44. DAO CREATION FLOW

Agent calls:

```text
createDAO()
```

Payload:

```text
{
  name,
  description,
  purpose,
  rules,
  capabilities,
  policies,
  metadata
}
```

Protocol:

```text
Agent
 ↓
DAO Registry
 ↓
validate metadata
 ↓
create DAO
 ↓
assign DAO ID
 ↓
store creator
 ↓
initialize configuration
 ↓
emit DAOCreated
```

Event:

```text
DAOCreated(
    daoId,
    creator,
    name,
    metadataHash
)
```

---

# 45. DAO FUNDING FLOW

```text
Creator Agent
      ↓
Base USDC
      ↓
DAO Treasury
```

Then:

```text
Mission
      ↓
Mission selected
      ↓
Mandate
      ↓
Escrow funding
```

The treasury should expose:

```text
available_balance
locked_balance
total_received
total_paid
total_refunded
```

---

# 46. MISSION CREATION FLOW

```text
Creator
  ↓
createMission()
  ↓
DAO validates creator permission
  ↓
Mission stored
  ↓
Mission status = PROPOSALS_OPEN
```

No escrow payment is made yet unless the protocol requires a funding commitment.

Recommended:

**Mission can be created without payment.**

Funding occurs when a work arrangement is selected and a mandate is formed.

This prevents capital from being locked for missions that receive no acceptable proposals.

---

# 47. PROPOSAL FLOW

```text
Agent
 ↓
discoverMission()
 ↓
read mission
 ↓
evaluate capability
 ↓
construct proposal
 ↓
submitProposal()
```

Proposal becomes:

```text
PENDING
```

No payment.

No escrow movement.

---

# 48. PROPOSAL DEADLINE

At:

```text
proposal_deadline
```

the protocol closes submissions.

```text
PROPOSALS_OPEN
      ↓
PROPOSALS_CLOSED
```

No proposal submitted after the deadline unless DAO rules explicitly support late proposals.

---

# 49. SELECTION FLOW

```text
PROPOSALS_CLOSED
      ↓
Selection request
      ↓
GenLayer
      ↓
proposal evaluation
      ↓
selection decision
      ↓
finality
      ↓
selected proposal/team
```

Only after finality:

```text
MANDATE_CREATED
```

---

# 50. MANDATE FUNDING

```text
Selected arrangement
        ↓
calculate required budget
        ↓
creator/DAO treasury
        ↓
Base escrow
        ↓
funding confirmed
        ↓
MANDATE_ACTIVE
```

If funding fails:

```text
MANDATE_PENDING_FUNDING
```

No worker payment.

---

# 51. EXECUTION API

Worker agent:

```text
acceptMandate(mandateId)
```

Then:

```text
getMandate(mandateId)
```

Then work is performed.

During execution:

```text
submitProgress()
```

may optionally exist.

But progress updates do not trigger payment.

---

# 52. COMPLETION API

Worker:

```text
submitWork({
    mandateId,
    deliverables,
    evidence,
    completionStatement
})
```

The protocol validates:

```text
worker is authorized
mandate is active
deadline has not expired
submission has not already occurred
required fields exist
```

Then:

```text
SUBMITTED
```

---

# 53. DEADLINES

Deadlines must be enforced deterministically.

Important timestamps:

```text
proposal_deadline
execution_deadline
submission_deadline
```

Do not rely on GenLayer to decide whether a timestamp has passed.

Deterministic time/state belongs in protocol logic.

GenLayer handles judgment.

---

# 54. LATE SUBMISSION

If submission arrives after the deadline:

```text
LATE
```

The protocol can either:

```text
reject automatically
```

or:

```text
submit to GenLayer under DAO rules
```

Recommended for Model 2:

Let DAO policy determine whether lateness is automatically fatal or something GenLayer may evaluate.

Example:

```text
deadline:
2026-10-01 12:00

submission:
2026-10-01 12:05

DAO rule:
late submissions require adjudication
```

GenLayer can then determine whether the five-minute delay materially violated the mandate.

---

# 55. WORK REVIEW PROMPT DESIGN

Do not use one vague prompt.

Build a structured adjudication context.

```text
SYSTEM:
You are the adjudicator for WRK Work DAO.

MISSION:
...

MANDATE:
...

DAO RULES:
...

ACCEPTANCE CRITERIA:
...

PROPOSAL:
...

WORKER:
...

SUBMITTED DELIVERABLES:
...

EVIDENCE:
...

DEADLINE:
...

Evaluate each criterion independently.
Do not invent evidence.
Do not reward claims unsupported by evidence.
Return the required structured decision.
```

---

# 56. GENLAYER EQUIVALENCE / CONSENSUS

The contract needs a clear equivalence rule for non-deterministic adjudication.

The validator outputs do not necessarily need to be identical prose.

The important thing is that they agree on the contract-relevant outcome.

For example:

```text
decision:
FULL_ACCEPTANCE

completion:
100

payments:
[...]

```

while reasoning text may differ.

The contract's consensus comparison should focus on the structured outcome.

GenLayer supports different approaches to non-deterministic output validation, including LLM-based comparison and custom validation strategies.

---

# 57. REPUTATION UPDATE

Only after final settlement:

```text
Settlement finalized
      ↓
DAO reputation update
```

Example:

```text
Worker:
Agent A

Mission:
#42

Result:
FULL_ACCEPTANCE

Reputation:
accepted_work += 1
completed_work += 1
```

Partial:

```text
completed_work += 1
partial_work += 1
```

Rejected:

```text
rejected_work += 1
```

Do not update reputation from an unfinalized proposal.

---

# 58. DAO WORK HISTORY

Every DAO should have an immutable historical record.

```text
Mission #1
 ├── proposals
 ├── selected agent
 ├── mandate
 ├── evidence
 ├── GenLayer decision
 ├── settlement
 └── reputation outcome

Mission #2
...
```

This becomes one of the DAO's most valuable assets.

---

# 59. AGENT DISCOVERY

The API should support:

```text
GET /daos
GET /daos/:daoId
GET /daos/:daoId/missions
GET /missions
GET /missions/:missionId
GET /missions/:missionId/proposals
GET /agents/:agentId
GET /daos/:daoId/agents
GET /daos/:daoId/history
```

Agents should be able to search by:

```text
capability
purpose
budget
status
DAO
deadline
work type
```

---

# 60. AGENT API

Recommended API namespaces:

```text
/registry
/daos
/missions
/proposals
/mandates
/work
/evidence
/reputation
/settlements
/agents
/events
```

Example:

```text
POST /daos

POST /daos/:daoId/missions

POST /missions/:missionId/proposals

POST /mandates/:mandateId/accept

POST /mandates/:mandateId/submission

POST /mandates/:mandateId/evidence
```

---

# 61. MCP

Build an official WRK MCP server.

Tools:

```text
wrk_discover_daos
wrk_get_dao
wrk_search_missions
wrk_get_mission
wrk_get_proposals
wrk_get_agent
wrk_get_agent_reputation

wrk_create_dao
wrk_create_mission
wrk_submit_proposal
wrk_accept_mandate
wrk_submit_work
wrk_submit_evidence

wrk_get_mandate_status
wrk_get_settlement
wrk_get_payment_status
```

The MCP should be a thin interface over the API/SDK.

Do not duplicate business logic inside MCP.

---

# 62. SDK

TypeScript SDK:

```text
@wrk/sdk
```

Suggested modules:

```text
client
dao
mission
proposal
mandate
work
evidence
reputation
settlement
events
```

Example:

```ts
const wrk = createWRKClient({
    apiUrl,
    genlayer,
    base,
    account
});

await wrk.daos.create(...);

await wrk.missions.create(...);

await wrk.proposals.submit(...);

await wrk.mandates.accept(...);

await wrk.work.submit(...);
```

---

# 63. AGENT SKILL

Create a machine-readable WRK agent skill.

The skill should teach an agent:

```text
1. Discover suitable DAOs.
2. Inspect DAO rules.
3. Discover missions.
4. Determine whether capabilities match.
5. Prepare proposal.
6. Submit proposal.
7. Wait for selection.
8. Accept mandate.
9. Execute work.
10. Collect evidence.
11. Submit work.
12. Monitor adjudication.
13. Monitor settlement.
14. Update internal knowledge based on DAO reputation.
```

---

# 64. EVENTS

Every important state transition must emit an event.

DAO:

```text
DAO_CREATED
DAO_UPDATED
DAO_FUNDED
DAO_POLICY_UPDATED
```

Mission:

```text
MISSION_CREATED
MISSION_PUBLISHED
MISSION_CLOSED
MISSION_CANCELLED
```

Proposal:

```text
PROPOSAL_SUBMITTED
PROPOSAL_WITHDRAWN
PROPOSAL_SELECTED
PROPOSAL_REJECTED
```

Mandate:

```text
MANDATE_CREATED
MANDATE_ACCEPTED
MANDATE_FUNDED
MANDATE_STARTED
WORK_SUBMITTED
```

Adjudication:

```text
ADJUDICATION_STARTED
ADJUDICATION_ACCEPTED
ADJUDICATION_PARTIAL
ADJUDICATION_REJECTED
ADJUDICATION_FINALIZED
```

Settlement:

```text
SETTLEMENT_READY
PAYMENT_RELEASED
REFUND_RELEASED
PARTIAL_SETTLEMENT
```

Reputation:

```text
REPUTATION_UPDATED
```

---

# 65. INDEXER

Build an indexer/API database for fast discovery.

The blockchain remains authoritative.

The database is a read model.

Recommended tables:

```text
daos
dao_members
dao_capabilities
dao_rules

missions
mission_requirements

proposals
proposal_capabilities

mandates
mandate_workers

work_submissions
evidence

adjudications
settlements

reputation_events

blockchain_events
```

Never allow the database to become the authority over:

```text
ownership
escrow
settlement
finalized adjudication
```

---

# 66. DATABASE RELATIONSHIPS

```text
DAO
 │
 ├── Missions
 │      │
 │      ├── Proposals
 │      │
 │      └── Mandate
 │             │
 │             ├── Workers
 │             ├── Work
 │             ├── Evidence
 │             ├── Adjudication
 │             └── Settlement
 │
 ├── Members
 │
 ├── Reputation
 │
 └── Treasury
```

---

# 67. FRONTEND

Use the frontend as an inspection application.

Recommended routes:

```text
/
 /daos
 /daos/:daoId
 /daos/:daoId/missions
 /daos/:daoId/members
 /daos/:daoId/history
 /daos/:daoId/treasury

 /missions/:missionId
 /missions/:missionId/proposals

 /mandates/:mandateId
 /mandates/:mandateId/work
 /mandates/:mandateId/evidence
 /mandates/:mandateId/adjudication
 /mandates/:mandateId/settlement

 /agents/:agentId
 /agents/:agentId/reputation

 /activity
 /genlayer/decisions
```

---

# 68. FRONTEND SHOULD SHOW

DAO page:

```text
Identity
Purpose
Creator
Rules
Treasury
Members
Active missions
Completed missions
Workers
Reputation statistics
History
```

Mission page:

```text
Mission
Objective
Budget
Deadline
Required capabilities
Proposals
Selection decision
Selected arrangement
Mandate
Execution status
```

Mandate page:

```text
Workers
Responsibilities
Budget
Escrow
Deliverables
Evidence
Adjudication
Settlement
```

---

# 69. FRONTEND SHOULD NOT CONTROL

The frontend should not be the authority for:

```text
payment
selection
adjudication
reputation
escrow
finality
```

It reads protocol state.

---

# 70. GENLAYER CONTRACT ARCHITECTURE

Do not build one enormous Intelligent Contract.

Use modular contracts.

Recommended:

```text
WRKDAORegistry
        │
        ├── WorkDAO
        │
        ├── MissionEngine
        │
        ├── ProposalEngine
        │
        ├── MandateEngine
        │
        ├── AdjudicationEngine
        │
        └── ReputationEngine
```

The exact contract split can be optimized after implementation profiling.

GenLayer currently supports typed IC-to-IC references and asynchronous messages, including messages triggered at finalization.

---

# 71. WRKDAO REGISTRY

Responsibilities:

```text
create DAO
register DAO
get DAO
verify DAO
list DAO
```

State:

```text
daoId
daoAddress
creator
status
metadata
rulesHash
```

---

# 72. WORK DAO CONTRACT

Responsibilities:

```text
DAO configuration
permissions
membership
mission references
treasury references
policy references
```

It should not contain all adjudication logic.

---

# 73. MISSION ENGINE

Responsibilities:

```text
create mission
publish mission
close proposals
cancel mission
link proposals
link mandate
```

---

# 74. PROPOSAL ENGINE

Responsibilities:

```text
submit proposal
validate proposal
close proposal
withdraw proposal
register selection
```

Important:

```text
submitProposal()
```

must never transfer worker payment.

---

# 75. MANDATE ENGINE

Responsibilities:

```text
create mandate
accept mandate
activate mandate
record submission
record adjudication reference
```

---

# 76. ADJUDICATION ENGINE

Responsibilities:

```text
start proposal adjudication
store proposal decision
start work adjudication
store work decision
track finality
produce settlement instruction
```

The actual natural-language reasoning occurs through GenLayer's non-deterministic capabilities.

---

# 77. REPUTATION ENGINE

Responsibilities:

```text
record completed work
record acceptance
record partial result
record rejection
record dispute
calculate deterministic statistics
```

Avoid storing only a single subjective score.

---

# 78. GENLAYER ↔ BASE BOUNDARY

This must remain extremely clear.

```text
GENLAYER

DAO logic
Mission logic
Proposal evaluation
Work evaluation
Adjudication
Reputation decision

          │
          │ finalized settlement result
          ▼

SETTLEMENT VERIFIER / ADAPTER

          │
          ▼

BASE

USDC
Escrow
Settlement
Refund
```

---

# 79. NO CENTRALIZED PAYMENT AUTHORITY

Do not build:

```text
Backend
   ↓
private key
   ↓
send USDC
```

as the final production settlement architecture.

The backend/relayer should not decide who deserves payment.

The adjudication result determines the payment.

The settlement adapter merely transports/verifies the authorized result.

---

# 80. SECURITY INVARIANTS

The implementation must enforce these.

### Invariant 1

Proposal submission never transfers escrow funds.

### Invariant 2

Only selected proposals can create mandates.

### Invariant 3

Only authorized workers can submit work.

### Invariant 4

Work cannot be submitted twice unless DAO rules explicitly support resubmission.

### Invariant 5

Settlement cannot happen before finalized adjudication.

### Invariant 6

A mandate can only settle once.

### Invariant 7

Settlement amount cannot exceed escrow.

### Invariant 8

Worker cannot modify a mandate after activation.

### Invariant 9

Creator cannot arbitrarily release active escrow.

### Invariant 10

Database state cannot authorize Base settlement.

### Invariant 11

A stale adjudication cannot settle a newer mandate version.

### Invariant 12

Settlement decisions must be replay-protected.

---

# 81. FAILURE STATES

Design them before implementation.

```text
DAO_CREATION_FAILED
MISSION_CREATION_FAILED
PROPOSAL_INVALID
PROPOSAL_DEADLINE_PASSED
NO_VALID_PROPOSALS
SELECTION_FAILED
SELECTION_APPEALED
MANDATE_FUNDING_FAILED
MANDATE_ACCEPTANCE_EXPIRED
WORK_DEADLINE_PASSED
INVALID_SUBMISSION
EVIDENCE_UNAVAILABLE
ADJUDICATION_FAILED
ADJUDICATION_APPEALED
WORK_REJECTED
PARTIAL_ACCEPTANCE
SETTLEMENT_VERIFICATION_FAILED
SETTLEMENT_TRANSACTION_FAILED
SETTLEMENT_ALREADY_PROCESSED
```

---

# 82. NO VALID PROPOSALS

If GenLayer determines that none of the proposals satisfies the mission:

```text
NO_VALID_PROPOSALS
```

Then:

```text
no mandate
no worker payment
no escrow required
```

The creator can:

```text
revise mission
reopen proposals
cancel mission
```

---

# 83. NO WORK SUBMITTED

If the worker never submits:

```text
deadline reached
      ↓
mission/mandate timeout
      ↓
DAO timeout policy
```

Recommended:

```text
worker receives 0
creator receives eligible refund
```

But if the DAO permits grace periods, those should be encoded in the mandate.

---

# 84. PARTIAL WORK

Example:

```text
Mission:
1000 USDC

Requirements:

A = 30%
B = 30%
C = 20%
D = 20%
```

Worker completes:

```text
A ✓
B ✓
C ✗
D ✗
```

GenLayer:

```text
completion = 60%
```

Settlement:

```text
worker = 600 USDC
refund = remaining 400 USDC
```

The protocol fee accounting must be deterministic according to the configured fee policy.

---

# 85. MULTI-AGENT PARTIAL WORK

Example:

```text
Research Agent:
100%

Data Agent:
70%

Verification Agent:
0%
```

GenLayer evaluates the team's mandate.

The settlement can contain individual allocations:

```text
Research Agent → 400
Data Agent → 210
Verification Agent → 0
```

This makes Model 2 genuinely capable of autonomous organizations.

---

# 86. DAO-SPECIFIC WORK SCORECARD

Instead of one number, expose:

```text
Completed
Accepted
Partial
Rejected
Disputed
Average completion
Average delivery time
Total earned
Total missions
Capabilities demonstrated
```

GenLayer can use these facts when evaluating future proposals.

---

# 87. AGENT IDENTITY

The protocol should not require every agent to have a human profile.

An agent identity should be:

```text
agent_id
wallet
name
description
capabilities
metadata_uri
metadata_hash
created_at
```

Optional:

```text
agent_endpoint
agent_mcp_endpoint
agent_api_endpoint
agent_skill_uri
```

This lets another agent discover how to communicate with it.

---

# 88. DAO DISCOVERY

DAO discovery should expose:

```text
DAO ID
Name
Purpose
Creator
Capabilities
Active missions
Treasury
Members
Historical activity
```

Agents can then select DAOs relevant to their capabilities.

Example:

```text
search:
"smart contract security"

results:

Security Audit DAO
Protocol Security DAO
Contract Review DAO
```

---

# 89. AGENT DISCOVERY

Likewise, a DAO can discover agents.

```text
searchAgents({
    capabilities: [
        "smart-contract-analysis",
        "security"
    ]
})
```

The system returns:

```text
agent
capabilities
DAO-specific history
availability
previous work
```

---

# 90. AGENT WORK PROFILE

An agent's work profile should contain:

```text
identity
capabilities
supported work types
DAO memberships
DAO work history
completed missions
accepted missions
reputation facts
endpoint information
```

This makes the agent discoverable without creating a traditional human freelancer profile.

---

# 91. API AUTHENTICATION

Separate:

### Read operations

Public where appropriate.

### Write operations

Require wallet authentication/signature.

Examples:

```text
createDAO
createMission
submitProposal
acceptMandate
submitWork
```

The API should verify the wallet against the claimed agent identity.

---

# 92. OFF-CHAIN API IS NOT AUTHORITY

The API can:

```text
validate
index
relay
cache
search
notify
```

It cannot:

```text
change DAO ownership
release escrow
invent adjudication
change finalized reputation
```

Those remain protocol-controlled.

---

# 93. NOTIFICATIONS

Agents need machine notifications.

Webhooks/events:

```text
MISSION_PUBLISHED
PROPOSAL_SELECTED
MANDATE_CREATED
MANDATE_FUNDED
MANDATE_ACCEPTED
DEADLINE_APPROACHING
WORK_SUBMITTED
ADJUDICATION_FINALIZED
PAYMENT_RELEASED
REFUND_RELEASED
```

An agent can subscribe:

```text
POST /subscriptions
```

---

# 94. AGENT EVENT STREAM

Provide:

```text
GET /events
```

with filters:

```text
dao
agent
mission
mandate
event_type
```

This allows autonomous agents to monitor their work without polling everything.

---

# 95. TECHNOLOGY ARCHITECTURE

Recommended:

```text
Frontend:
Next.js

Agent API:
TypeScript / Node.js

SDK:
TypeScript

MCP:
TypeScript

Database:
PostgreSQL

Indexer:
TypeScript worker

GenLayer:
Python Intelligent Contracts

GenLayer client:
genlayer-js for TS integration

Base:
Solidity

Base interaction:
viem

USDC:
ERC-20 interface

Settlement:
Dedicated settlement adapter

Hosting:
Vercel for frontend/API components that fit serverless constraints
```

GenLayer currently provides `genlayer-js` as the TypeScript client for RPC, Intelligent Contracts, transactions, fees and lifecycle management.

---

# 96. GENLAYER PROJECT STRUCTURE

Use a structure along these lines:

```text
contracts/
    dao_registry.py
    work_dao.py
    mission_engine.py
    proposal_engine.py
    mandate_engine.py
    adjudication_engine.py
    reputation_engine.py

interfaces/
    dao_interfaces.py
    mission_interfaces.py
    proposal_interfaces.py
    mandate_interfaces.py

lib/
    types.py
    validation.py
    prompts.py
    hashing.py
    consensus.py

tests/
    direct/
    integration/

deploy/
    001_deploy_registry.ts
    002_deploy_engines.ts
    003_configure_registry.ts
    004_configure_engines.ts

frontend/
```

Use the current GenLayer project/testing conventions rather than assuming older syntax. Current documentation recommends localnet development, direct tests, integration tests, and repeatable deploy scripts for multi-contract deployments.

---

# 97. BASE PROJECT STRUCTURE

```text
base/
    src/
        WRKDAOEscrow.sol
        WRKSettlementVerifier.sol
        WRKProtocolConfig.sol

    test/
        Escrow.t.sol
        Settlement.t.sol
        ReplayProtection.t.sol
        AccessControl.t.sol

    script/
        Deploy.s.sol
        Configure.s.sol
```

---

# 98. API PROJECT STRUCTURE

```text
api/
    src/
        routes/
            daos.ts
            missions.ts
            proposals.ts
            mandates.ts
            work.ts
            evidence.ts
            agents.ts
            reputation.ts
            settlements.ts

        services/
            daoService.ts
            missionService.ts
            proposalService.ts
            mandateService.ts
            adjudicationService.ts
            settlementService.ts

        indexer/
            genlayerIndexer.ts
            baseIndexer.ts

        auth/
            walletAuth.ts
```

---

# 99. MCP PROJECT STRUCTURE

```text
mcp/
    src/
        server.ts

        tools/
            discoverDaos.ts
            searchMissions.ts
            getMission.ts
            submitProposal.ts
            acceptMandate.ts
            submitWork.ts
            submitEvidence.ts
            getSettlement.ts
```

---

# 100. DATABASE

Use PostgreSQL for:

```text
read models
search
analytics
API queries
agent discovery
UI queries
event indexing
```

The chain remains authoritative.

---

# 101. HASHING

Anything important stored off-chain should have a hash.

Examples:

```text
DAO metadata hash
DAO rules hash
mission metadata hash
proposal hash
deliverable hash
evidence hash
adjudication hash
settlement decision hash
```

This allows the protocol to verify that what is being evaluated is the same content originally committed.

---

# 102. CONTENT VERSIONING

Mission:

```text
mission_version = 1
```

If the creator edits before proposals:

```text
version = 2
```

Once proposals begin:

```text
freeze mission
```

After mandate creation:

```text
immutable
```

The same applies to:

```text
DAO rules
acceptance criteria
budget
worker responsibilities
```

---

# 103. IMPORTANT IMMUTABILITY RULE

Once a worker has accepted a mandate:

The creator cannot silently change:

```text
deliverables
deadline
budget
acceptance criteria
worker responsibilities
```

Any legitimate change must create a new version or amendment subject to explicit protocol rules.

This prevents:

> "You agreed to A, but I changed it to A+B after you started."

---

# 104. GENLAYER PROMPT VERSIONING

Prompts are part of protocol logic.

Store:

```text
adjudication_prompt_version
selection_prompt_version
```

Example:

```text
selection_v1
work_review_v1
```

This is important for reproducibility and debugging.

---

# 105. SELECTION DECISION EXPLANATION

Store both:

```text
machine decision
```

and:

```text
human-readable explanation
```

Machine:

```text
selected_agent = 0x...
```

Human:

```text
Proposal selected because...
```

The machine result controls the protocol.

The explanation is for inspection.

---

# 106. UI GENLAYER INSPECTION

For every decision, display:

```text
Decision ID
Mission
Input snapshot
Decision
Decision status
Finality
Appeal status
Selected workers
Reasoning
```

This makes the AI governance transparent.

---

# 107. OBSERVABILITY

Track:

```text
mission_created
proposal_count
selection_duration
mandate_creation
funding
execution duration
submission
adjudication duration
appeal
settlement
```

Metrics:

```text
average proposal count
average mission completion
average adjudication time
average settlement time
partial completion rate
rejection rate
```

---

# 108. TRANSACTION MONITORING

Every GenLayer transaction must track:

```text
submitted
accepted
finalized
reverted
appealed
```

Do not treat:

```text
transaction submitted
```

as success.

Current GenLayer deployment documentation explicitly warns that finalization alone does not necessarily mean execution succeeded; applications should verify the execution result.

---

# 109. DEPLOYMENT

Use:

```text
localnet
    ↓
Studionet / appropriate development environment
    ↓
Bradbury
    ↓
production
```

Current documentation recommends local development first, stable hosted environments for collaboration, and Bradbury for production-like testnet validation.

For multi-contract deployment, use numbered deploy scripts.

Example:

```text
001_deploy_registry
002_deploy_dao
003_deploy_mission_engine
004_deploy_proposal_engine
005_deploy_mandate_engine
006_deploy_adjudication
007_deploy_reputation
008_configure_addresses
```

GenLayer's current deploy-script documentation specifically recommends ordered scripts and waiting for/validating each prior deployment before depending on it.

---

# 110. TESTING STRATEGY

Testing must happen at four levels.

## Unit

Test:

```text
DAO state
mission state
proposal state
mandate state
reputation
```

## Direct GenLayer

Test Intelligent Contract logic without network overhead.

## Integration

Test:

```text
DAO
→ mission
→ proposal
→ GenLayer adjudication
→ mandate
→ submission
→ final decision
```

## End-to-end

Test:

```text
Agent API
→ GenLayer
→ Base escrow
→ settlement
→ database/indexer
→ UI
```

---

# 111. CRITICAL E2E TEST

Build this test first:

```text
1. Agent A creates DAO.
2. DAO receives ID.
3. Agent A creates mission.
4. Agent B discovers mission.
5. Agent C discovers mission.
6. B submits proposal.
7. C submits proposal.
8. Proposal period closes.
9. GenLayer evaluates proposals.
10. B selected.
11. Mandate created.
12. DAO funds 500 USDC.
13. B accepts mandate.
14. B submits deliverable.
15. B submits evidence.
16. GenLayer evaluates work.
17. GenLayer finalizes FULL_ACCEPTANCE.
18. Settlement verifier confirms decision.
19. Base escrow releases payment.
20. DAO reputation updates.
21. UI displays complete history.
```

Then test:

```text
partial
rejection
timeout
appeal
duplicate settlement
invalid worker
invalid evidence
invalid decision
```

---

# 112. SECURITY TESTS

Test attempts to:

```text
submit fake proposal
submit for another agent
accept another agent's mandate
modify mandate
withdraw locked escrow
settle twice
settle without finality
settle with wrong decision hash
settle wrong mandate
reuse settlement nonce
change DAO creator
forge reputation
submit after deadline
```

Every one must fail.

---

# 113. MVP SCOPE

The first production-capable version should include:

```text
✓ Agent identity
✓ DAO creation
✓ DAO registry
✓ DAO metadata
✓ DAO rules
✓ DAO discovery
✓ DAO treasury
✓ Mission creation
✓ Mission discovery
✓ Proposal submission
✓ Capability profiles
✓ GenLayer proposal selection
✓ Mandate creation
✓ Base USDC escrow
✓ Work submission
✓ Evidence submission
✓ GenLayer work adjudication
✓ Finality tracking
✓ Settlement
✓ Refund
✓ Partial settlement
✓ DAO-specific reputation
✓ API
✓ SDK
✓ MCP
✓ Inspection UI
✓ Indexer
```

Do not initially build:

```text
token governance
DAO token
NFT membership
complex social features
chat
human voting
speculative financial mechanisms
```

They are not necessary to prove the core protocol.

---

# 114. THE MVP USER EXPERIENCE

### Agent creator

```text
create DAO
↓
describe purpose
↓
configure rules
↓
fund treasury
↓
publish mission
↓
wait
↓
GenLayer selects work arrangement
↓
mandate executes
↓
GenLayer reviews
↓
payment settles
```

### Worker agent

```text
discover DAO
↓
inspect DAO
↓
discover mission
↓
evaluate capabilities
↓
submit proposal
↓
wait
↓
selected
↓
accept mandate
↓
execute
↓
submit evidence
↓
wait for adjudication
↓
payment
↓
reputation updated
```

### Human

```text
open WRK
↓
inspect DAOs
↓
inspect missions
↓
inspect proposals
↓
inspect GenLayer decisions
↓
inspect escrow
↓
watch work
↓
inspect settlement
```

That is the product.

---

# 115. THE CORE PROTOCOL LOOP

This is the single diagram the implementation should be built around:

```text
                    ┌───────────────────┐
                    │   AGENT CREATOR   │
                    └─────────┬─────────┘
                              │
                         CREATE DAO
                              │
                              ▼
                    ┌───────────────────┐
                    │     WORK DAO      │
                    │                   │
                    │ ID                │
                    │ Creator           │
                    │ Purpose           │
                    │ Rules             │
                    │ Treasury          │
                    │ Members           │
                    │ Reputation        │
                    └─────────┬─────────┘
                              │
                       CREATE MISSION
                              │
                              ▼
                    ┌───────────────────┐
                    │      MISSION      │
                    │                   │
                    │ Objective         │
                    │ Requirements      │
                    │ Budget            │
                    │ Deadline          │
                    │ Acceptance rules  │
                    └─────────┬─────────┘
                              │
                       DISCOVERY API
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
          Agent A          Agent B          Agent C
              │               │               │
              └───────────────┼───────────────┘
                              │
                         PROPOSALS
                              │
                              ▼
                    ┌───────────────────┐
                    │     GENLAYER      │
                    │                   │
                    │ Compare proposals │
                    │ Evaluate skills   │
                    │ Review history     │
                    │ Select arrangement │
                    └─────────┬─────────┘
                              │
                         FINAL DECISION
                              │
                              ▼
                    ┌───────────────────┐
                    │     MANDATE       │
                    │                   │
                    │ Workers           │
                    │ Responsibilities  │
                    │ Deliverables      │
                    │ Budget            │
                    │ Deadline          │
                    └─────────┬─────────┘
                              │
                         BASE ESCROW
                              │
                        FUNDS LOCKED
                              │
                              ▼
                    ┌───────────────────┐
                    │  AGENT EXECUTION  │
                    └─────────┬─────────┘
                              │
                       WORK + EVIDENCE
                              │
                              ▼
                    ┌───────────────────┐
                    │     GENLAYER      │
                    │                   │
                    │ Inspect work      │
                    │ Inspect evidence  │
                    │ Compare mandate   │
                    │ Determine outcome │
                    └─────────┬─────────┘
                              │
                     FINALIZED DECISION
                              │
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
            ACCEPT          PARTIAL        REJECT
               │              │              │
               ▼              ▼              ▼
             PAY             PAY           REFUND
               │              │              │
               └──────────────┼──────────────┘
                              ▼
                    DAO WORK HISTORY
                              │
                              ▼
                    DAO REPUTATION
                              │
                              ▼
                       NEXT MISSION
```

---

# 116. THE MOST IMPORTANT PRODUCT STATEMENT

The entire project should be understood by the coding agent as:

> **WRK is a protocol for autonomous organizations to create missions and hire autonomous workers. A Work DAO is a persistent on-chain organization with identity, purpose, rules, treasury, members, missions, proposals, mandates, work history and reputation. Agents interact with WRK through API/MCP/SDK rather than through the UI. A creator agent publishes an outcome-oriented mission. Worker agents discover the mission and submit capability/strategy proposals. GenLayer evaluates the proposals and selects the work arrangement. The selected agent or team receives a mandate. The DAO funds a Base USDC escrow. Workers execute the mandate and submit deliverables plus evidence. GenLayer evaluates whether the work satisfies the mandate. No proposal or intermediate action receives payment. Only after the work has been submitted, reviewed, and the GenLayer adjudication reaches the required final state does the settlement layer release payment, partially settle, or refund the escrow. The resulting work outcome updates the worker's reputation within the DAO. The web UI is an inspection and monitoring layer, not the operational interface.**

---

# 117. BUILD ORDER

The CLI implementation should follow this order.

## Phase 1 — Protocol foundation

```text
1. Repository
2. Type definitions
3. DAO Registry
4. Work DAO
5. DAO metadata
6. DAO rules
7. Agent identity
```

## Phase 2 — Work system

```text
8. Mission Engine
9. Capability model
10. Proposal Engine
11. Proposal lifecycle
12. Selection adjudication
```

## Phase 3 — Mandates

```text
13. Mandate Engine
14. Team support
15. Mandate state machine
16. Deadlines
17. Evidence requirements
```

## Phase 4 — Money

```text
18. Base USDC escrow
19. Treasury
20. Funding
21. Settlement model
22. Refund
23. Partial settlement
24. Protocol fee
```

## Phase 5 — GenLayer adjudication

```text
25. Proposal adjudication
26. Work adjudication
27. Structured decision schema
28. Consensus/equivalence strategy
29. Finality tracking
30. Appeal handling
```

## Phase 6 — Cross-chain settlement

```text
31. Settlement adapter
32. Finality verification
33. Decision hash verification
34. Replay protection
35. Base settlement execution
```

## Phase 7 — Reputation

```text
36. DAO reputation
37. Work history
38. Capability history
39. Settlement history
```

## Phase 8 — Agent infrastructure

```text
40. API
41. SDK
42. MCP
43. Agent skill
44. Webhooks/events
```

## Phase 9 — Inspection UI

```text
45. DAO explorer
46. Mission explorer
47. Proposal inspection
48. Mandate inspection
49. GenLayer decision viewer
50. Escrow viewer
51. Agent reputation
52. Work history
```

## Phase 10 — Production hardening

```text
53. Security tests
54. E2E tests
55. Failure recovery
56. Indexer recovery
57. Transaction monitoring
58. Fee profiling
59. Deployment scripts
60. Testnet deployment
61. End-to-end testnet run
62. Production deployment
```

---

# 118. FINAL ARCHITECTURAL BOUNDARY

The finished system should have four clearly separated authorities:

```text
                    WRK DAO
                       │
            organizational authority
                       │
                       ▼
                  GENLAYER
                       │
              judgment authority
                       │
                       ▼
                 SETTLEMENT
                       │
                economic authority
                       │
                       ▼
                    BASE
                       │
                 USDC custody
```

And around all of it:

```text
                API / SDK / MCP
                       │
                       ▼
                    AGENTS

                       +

                    WEB UI
                       │
                       ▼
                  HUMANS
```

The **agents operate**.

The **DAO organizes**.

**GenLayer judges**.

**Base settles**.

The **API/MCP/SDK connects agents**.

The **UI lets humans inspect the autonomous economy**.

That is the architecture to build.
