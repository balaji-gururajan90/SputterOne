# SputterOne

**A Physics-Informed Reduced-Order Magnetron Sputtering Simulation Platform**

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Pages](https://img.shields.io/badge/Live-GitHub%20Pages-brightgreen)](https://balaji-gururajan90.github.io/SputterOne/)

---

## Live Simulator

**[Launch SputterOne →](https://balaji-gururajan90.github.io/SputterOne/)**

No installation. No dependencies. Runs entirely in any modern web browser.

---

## Overview

SputterOne is a browser-based physics-informed reduced-order simulation platform for real-time exploration of magnetron sputtering process conditions. It integrates multiple physics modules within a unified computational environment, eliminating the need for specialised software installation while maintaining interactive performance.

### Physics Modules

- **Yamamura–Bohdansky sputtering yield** — 8 target materials (Cu, Al, Ti, Zn, Sn, W, Ta, Mo)
- **Kinetic-theory mean free path transport** — pressure-dependent regime classification
- **Probabilistic gas-phase scattering** — ballistic / moderate / diffusive regimes
- **Berg-framework reactive sputtering hysteresis** — Ar/O₂ atmospheres
- **Co-sputtering composition estimation** — up to 3 independent guns
- **Bauer-scheme growth mode classification** — FM, VW, SK modes
- **Vacuum environment contextualisation** — base pressure reference, discharge stability warning

### Key Features

- Real-time interactive parameter exploration
- Integrated process advisory module
- 14-chapter tutorial with animated diagrams
- 5 structured virtual laboratory modules with CSV export
- AI-assisted Recipe Advisor
- DC/RF mode switching
- Multi-gun co-sputtering

---

## Validation

Sputtering yield predictions agree with Yamamura–Tawara tabulated values within experimental data scatter across all 8 materials. Mean free path accuracy within 2% of analytical kinetic theory. Pressure-dependent transport reproduces deposition-rate attenuation and regime transitions consistent with established thin-film zone models.

---

## Repository Structure

```
/
├── index.html              ← Home page
├── simulator.html          ← Main simulator
├── tutorial.html           ← 14-chapter tutorial
├── labs.html               ← Virtual lab modules
├── about.html              ← About & physics reference
├── physics.html            ← Physics documentation
├── brochure.html           ← Platform brochure
├── style.css               ← Global styles
├── app.js                  ← Physics engine
├── tutorial_logic.js       ← Tutorial controller
├── img/                    ← Icons and images
├── CITATION.cff            ← Machine-readable citation
└── LICENSE                 ← MIT Licence
```

---

## Citation

If you use SputterOne in your research or teaching, please cite:

```
Gururajan, B. (2025). SputterOne: A Physics-Informed Reduced-Order 
Magnetron Sputtering Simulation Platform for Process Optimisation 
and Thin-Film Deposition Modelling. Yuan Ze University, Taiwan. 
https://balaji-gururajan90.github.io/SputterOne/
```
## Citation

If you use SputterOne in research, please cite:

Balaji Gururajan (2026).
SputterOne v1.0.0: A Physics-Informed Reduced-Order Magnetron Sputtering Simulation Platform.
Zenodo.
https://doi.org/10.5281/zenodo.20727719

A `CITATION.cff` file is included for automatic citation parsing by GitHub, Zotero, and Mendeley.

---

## Licence

MIT Licence — see [LICENSE](LICENSE) for details.

---

## Author

**Dr. Balaji Gururajan**  
Assistant Professor, Department of Electrical Engineering  
Yuan Ze University, Taiwan  
balaji@saturn.yzu.edu.tw
