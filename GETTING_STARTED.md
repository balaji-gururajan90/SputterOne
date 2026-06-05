# Getting Started with SputterOne

**A step-by-step guide for researchers familiar with magnetron sputtering**

---

## 1. Launch the Simulator

No installation required. Open in any modern browser:

**Online (recommended):**
```
https://balaji-gururajan90.github.io/SputterOne/
```
---

## 2. Understand the Interface

The simulator has three panels:

| Panel | Location | Purpose |
|---|---|---|
| **Control sidebar** | Left | Set all process parameters |
| **Chamber canvas** | Centre | Real-time particle visualisation |
| **Diagnostic panel** | Right | Live process metrics and charts |

Key diagnostic outputs updated every frame:
- Discharge voltage (V) and ion energy (eV)
- Sputtering yield Y (atoms/ion)
- Mean free path λ (cm) and scattering ratio d/λ
- Transport regime: Ballistic / Moderate / Diffusive
- Deposition rate, film thickness (nm), non-uniformity (%)
- Base pressure reference (1×10⁻⁶ Torr) and working pressure

---

## 3. Set Your First Recipe

A typical DC magnetron sputtering recipe for Cu:

| Parameter | Recommended starting value |
|---|---|
| Target material | Cu |
| Operating mode | DC |
| Power | 200 W |
| Working pressure | 5 mTorr |
| Target–substrate distance | 10 cm |
| Target diameter | 2 inch |
| Substrate diameter | 2 inch |
| Gas composition | 100% Ar |
| Magnetic field | 0.05 T |

Click **Start** to run the simulation. Particles will appear on the chamber canvas within 1–2 seconds.

> ⚠️ If working pressure is set below 0.5 mTorr, an amber discharge stability warning will appear. Real magnetron discharges typically require at least 0.5 mTorr to sustain a stable glow discharge.

---

## 4. Use the Process Advisory Module

Before running a recipe, click **Check Recipe** in the right panel. The advisory module will:

- Flag physically inconsistent parameter combinations
- Classify the expected transport regime (Ballistic / Moderate / Diffusive)
- Estimate non-uniformity percentage
- Suggest a corrected recipe if issues are found

This is particularly useful for **pre-screening process conditions** before physical experimentation.

---

## 5. Explore Key Process Dependencies

### Pressure vs. Transport Regime
Vary working pressure from 1.5 to 20 mTorr and observe:
- At low pressure (< 2 mTorr): ballistic transport, directional flux, high non-uniformity
- At moderate pressure (2–8 mTorr): partial scattering, improved uniformity
- At high pressure (> 10 mTorr): diffusive transport, thermalised atoms, low deposition rate

### Power vs. Sputtering Yield
Increase DC power from 100 W to 500 W on Cu, W, and Zn targets. Note:
- Yield increases non-linearly with ion energy
- W and Ta show much lower yield than Cu and Zn at the same power
- RF mode shows systematically lower yield than DC at equal power

### Co-Sputtering Composition
Enable Gun 2 and Gun 3 with different materials (e.g. Cu + Al + Zn):
- Set equal power on all three guns
- Observe that film composition is **not** equal — it is governed by the Yamamura–Bohdansky yield ratio
- This directly demonstrates why Cu–Al alloy deposition requires power compensation

### Reactive Sputtering Hysteresis
Switch to a reactive recipe (e.g. Ti target, add O₂):
- Increase O₂ fraction incrementally from 0% to 30%
- Observe yield drop as target poisoning onset occurs
- Reduce O₂ — note the hysteresis: metallic mode is not recovered at the same O₂ fraction

---

## 6. Export Data

Three CSV export formats are available from the right panel:

| Export | Contents |
|---|---|
| **Time series** | Rate, yield, MFP, uniformity — logged per second |
| **Radial profile** | Binned thickness distribution across substrate diameter |
| **Process summary** | All parameters and final metrics at end of run |

Use the radial profile export to compare uniformity across different target–substrate geometries.

---

## 7. Set a Thickness Target

Enter a target film thickness (nm) in the **Thickness Target** field and click **Set Target**. The simulator will:
- Display a real-time progress bar
- Auto-pause when the target thickness is reached
- Show a summary of final thickness, elapsed time, uniformity %, and average deposition rate

Useful for estimating deposition time before a physical run.

---

## 8. Vacuum Environment Context

SputterOne models the working gas environment only. The diagnostic panel displays:
- **Base pressure**: 1×10⁻⁶ Torr (fixed reference — consistent with a turbomolecular-pumped system before Ar backfill)
- **Working pressure**: user-adjustable 0.1–30 mTorr

Residual gas contamination and outgassing effects are outside the reduced-order model scope. Users requiring film purity estimates should account for base pressure and residual gas partial pressures from their specific chamber.

---

## 9. Operating Parameter Ranges

| Parameter | SputterOne range | Typical real-world range |
|---|---|---|
| Working pressure | 0.1–30 mTorr | 0.5–15 mTorr |
| DC/RF power | 50–500 W | 50–300 W |
| Target–substrate distance | 3–20 cm | 5–15 cm |
| Target materials | Cu, Al, Ti, Zn, Sn, W, Ta, Mo | Any |
| Gas composition | Ar, Ar/O₂ | Ar, Ar/O₂, Ar/N₂ |
| Substrate temperature | 250–600 K | 300–1200 K |
| Discharge stability | > 0.5 mTorr (warned below) | ≳ 0.5–1 mTorr |

---

## 10. Known Limitations

SputterOne is a reduced-order model — not a full PIC or Monte Carlo solver. Be aware of:

- **Plasma kinetics not resolved** — discharge voltage and ion current are parametric estimates, not self-consistent plasma solutions
- **Gas temperature fixed at 300 K** — real gas heats to 350–500 K near the magnetron; MFP may be underestimated by 8–30% at high power
- **No residual gas contamination** — film purity effects from H₂O, O₂, N₂ at base pressure are not modelled
- **Deposition rate in relative units** — absolute rate values are scaled for visualisation; use for trend analysis, not fab-grade process fitting
- **HiPIMS not supported** — peak powers > 1 kW and pulsed waveforms are outside the model scope

---

## Citation

If you use SputterOne in your research or teaching, please cite:

```
Gururajan, B. (2025). SputterOne: A Physics-Informed Reduced-Order 
Magnetron Sputtering Simulation Platform for Process Optimisation 
and Thin-Film Deposition Modelling. Yuan Ze University, Taiwan.
https://balaji-gururajan90.github.io/SputterOne/
```

A `CITATION.cff` file is included for automatic citation parsing by GitHub, Zotero, and Mendeley.

---

## Contact

**Dr. Balaji Gururajan**  
Department of Electrical Engineering, Yuan Ze University, Taiwan  
balaji@saturn.yzu.edu.tw
