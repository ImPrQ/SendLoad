# C4HP Fatigue Engine Upgrades - Mathematical Specification

This document details the exact mathematical models, reasoning, and implementation mechanics for upgrading the bi-exponential fatigue engine in SendLoad, updated to reflect the per-climb mechanics and Training Quality metric.

---

## 1. Dynamic Half-Lives (Intensity-Scaled Recovery)

**User Insight:** *If we use the session average, it will make a session with many easy climbs and hard climbs be the same as a session consisting only of moderate intensity climbing. I propose to do it climb per climb.*

**Reasoning & Biology:** You are entirely correct. A limit boulder (RPE 9) induces deep structural and CNS fatigue regardless of how many easy warm-ups you do alongside it. We will calculate the Dynamic Half-Life **per climb**.

Are multipliers of 1.2x to 1.5x biologically accurate? Yes, for the *Slow Track* (CNS/Tissue). 
- A moderate session (RPE 6-7) might require ~24-36h for full systemic/CNS baseline return.
- A true max limit session (RPE 9-10) can easily require 48-72h+ for CNS repair and tendon remodeling. 
- $72h / 36h = 2.0x$. A multiplier of 1.5x at RPE 9+ is actually a conservative, safe estimate for the Slow Track. The Fast Track (metabolic flush, taking ~6-12h) remains mostly unaffected.

**Mathematical Implementation:**
1. For each climb in the array, evaluate its individual `rpe`.
2. Determine the Climb's Half-Life Multiplier ($M_{hl}$):
   - $\text{RPE} \le 7.0 \implies M_{hl} = 1.0$
   - $7.0 < \text{RPE} \le 8.0 \implies M_{hl} \text{ interpolates from } 1.0 \to 1.2$
   - $8.0 < \text{RPE} \implies M_{hl} \text{ interpolates from } 1.2 \to 1.5$
3. Apply this multiplier *only* to the Slow Half-Life for that specific climb's load contribution:
   - $hl_{fast, climb} = \text{baseFastHL}$
   - $hl_{slow, climb} = \text{baseSlowHL} \times M_{hl}$
4. Normalize this specific climb's integral contribution using its specific $hl_{slow, climb}$ to perfectly maintain the 50% equilibrium.

---

## 2. Intra-Session Fatigue Tax (Non-Linear Accumulation)

**User Insight:** *I want this to be calculated per climb, so that if the first half of your session is done above 30%, it will not get a multiplier but the rest will.*

**Reasoning:** This is a brilliant concept. It elegantly models intra-session fatigue. As you progress through a heavy session, your instantaneous readiness drops. If you keep pulling hard late in the session, you cross into the "danger zone", and those specific late-session climbs receive the junk-volume Fatigue Tax.

**Mathematical Implementation:**
We process sessions chronologically, and within each session, we process climbs sequentially:
1. At the start of the session ($t_i$), compute the starting Readiness ($R_{neuro}, R_{meta}, R_{struct}$) from all past sessions.
2. For each climb sequentially:
   - Determine the Tax Multipliers ($M_{tax, neuro}$, $M_{tax, meta}$, $M_{tax, struct}$) based on the *current* Readiness state.
   - Calculate the climb's standard load ($L_{base}$).
   - Calculate the climb's **Taxed Load**: $L_{taxed} = L_{base} \times M_{tax}$.
   - **Crucial Step:** Instantly add $L_{taxed}$ to the Readiness gauges *before* evaluating the next climb. (We assume $\Delta t = 0$ between climbs for simplicity, so the readiness just drops progressively as the array is processed).
3. **Chronic Compensation:** You noted that we might need to multiply the Chronic load by a small factor so it doesn't fall behind. We will introduce a `Chronic Absorption Rate`. 
   - If a climb generates $+30$ extra "taxed" CLU, and the absorption rate is $20\%$, the Chronic load receives the base load $+ (30 \times 0.20)$. This allows a small amount of "grinding" to contribute to fitness, but heavily penalizes the rest.

---

## 3. Training Quality Score (Junk Volume Metric)

**User Insight:** *Calculate a score that tells you how high quality your load is for adaptations, so based on the amount of junk volume.*

**Mathematical Implementation:**
Since we now track the Base Load (adaptations) and the Taxed Load (damage), the "Training Quality" of a session is simply the ratio between the two:
$$ \text{Quality \%} = \left( \frac{\text{Total Base Load}}{\text{Total Taxed Load}} \right) \times 100 $$
- If you stay fresh (Readiness > 50%), Taxed Load = Base Load $\implies$ **100% Quality**.
- If you do your entire session deeply fatigued (Readiness < 30%), Taxed Load = 1.3x Base Load $\implies$ **76% Quality**.
This metric will be added to the session history UI and Dashboard to give you immediate feedback on whether you successfully avoided junk volume.

---

## 4. Short vs. Long Term Fatigue in the Same Bar?

**User Insight:** *Does it make sense to put short and long term fatigue in the same bar?*

**Reasoning:** Yes, biologically, your "Readiness to Perform" is constrained by whichever system is failing. If your CNS is fried (Slow Track), you cannot pull hard, even if your local muscles are metabolically flushed (Fast Track). The singular bar represents your *total systemic readiness*. However, visually separating them within that same bar (as the UI currently does with opacity/stripes) is highly valuable because it tells you *why* you are unready (e.g., "I am at 40% readiness, but it's mostly metabolic fatigue so I'll be fine by tomorrow").

---

## 5. UI & Settings Menu Integration

To ensure full control, all mathematical constants for these new mechanics will be exposed to the user.

### Settings Menu Additions
A new section `Fatigue Engine Dynamics` will be added containing:
- **Fatigue Tax Multipliers:** Inputs for the `<50%` Readiness Tax (Default: 1.15x) and `<30%` Readiness Tax (Default: 1.30x).
- **Dynamic Half-Life Scales:** Inputs for the RPE 8 Slow-Track multiplier (Default: 1.2x) and RPE 9+ multiplier (Default: 1.5x).
- **Chronic Absorption Rate:** Slider/Input (0% to 100%, Default: 20%) determining how much of the "Taxed" penalty load actually contributes to Chronic fitness.
- **Info Links:** `(i)` buttons next to each setting group that trigger `goToInfo('fatigue-tax')` to smoothly scroll to the documentation.

### Info Tab Documentation Additions
The Information View will receive dedicated subsections:
- **Intra-Session Fatigue Tax:** Explaining how pulling late in a session drops quality.
- **Dynamic Slow-Track Recovery:** Explaining why RPE 9 takes mathematically longer to recover from than RPE 7.
- **Training Quality Score:** Explaining the ratio of Base vs. Taxed load.
