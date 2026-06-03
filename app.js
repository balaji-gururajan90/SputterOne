window.currentLang = window.currentLang || 'en';
window.TRANSLATIONS = window.TRANSLATIONS || {
  en: {
    'start-process': 'Start Process',
    'resume-process': 'Resume Process',
    'pause-process': 'Pause Process',
    'tut-next': 'Next',
    'tut-finish': 'Finish',
    'tut-step1-title': 'Power',
    'tut-step1-text': 'Adjust sputtering power.',
    'tut-step2-title': 'Pressure',
    'tut-step2-text': 'Adjust chamber pressure.',
    'tut-step3-title': 'Magnetic Field',
    'tut-step3-text': 'Adjust magnetic confinement.'
  }
};

// Global Simulation State
let STATE = {
    mode: 'simulation', // 'intro', 'transition', 'tutorial', 'simulation'
    introProgress: 0.0, // 0.0 to 1.0 for the zoom transition
    tutorialStep: 0,

    power: 300,         // W (DC/RF Power)
    pressure: 15,       // mTorr
    basePressureTorr: 1e-6, // Torr - fixed base pressure assumption
    magField: 0.03,     // T (Tesla)
    argonPercent: 100,  // % Ar working gas (complement of O2 in Ar)
    oxygenPercent: 0,   // % O2 in Ar
    temperature: 300,   // K (Gas Temp)
    paused: false,

    // Toggles â€” all start OFF; user enables them before/after Start
    hqPlasma: false,
    drawMagLines: false,
    drawElectrons: false,
    substrateRotEnabled: false,
    lowClutterMode: false,

    // Opacities (0.0 to 1.0)
    opField: 1.0,
    opElec: 1.0,
    opGlow: 1.0,
    opPart: 1.0,

    // Physical Constants and parameters
    material: 'Cu',     // Alias for sources[0].material (backward compat)
    erosionLevel: 0,    // Target tracking

    // Co-sputtering sources / guns
    sources: [
        { material: 'Cu', active: false, deposited: 0, power: 300, powerType: 'DC', yield: 0 },
        { material: 'Al', active: false, deposited: 0, power: 200, powerType: 'RF', yield: 0 },
        { material: 'Zn', active: false, deposited: 0, power: 200, powerType: 'RF', yield: 0 }
    ],
    gunPositions: [0, 0, 0], // canvas X positions of each gun, updated each frame


    // Stats tracking
    yield: 0.0,
    illustrativeYield: 0.0,
    totalDeposited: 0,
    depositThisSecond: 0,
    avgThickness: 0.0,
    effectiveDepositionRate: 0.0,
    transportFactor: 1.0,
    stickingCoeff: 0.8,
    totalCurrent: 0.0,
    representativeVoltage: 0.0,
    representativeIonEnergy: 0.0,
    filmComposition: {},
    landingDiagnostics: {
        totalLandings: 0,
        centerLandings: 0,
        edgeLandings: 0,
        radialHistogram: [0, 0, 0, 0],
        centerEdgeRatio: 0,
        edgeFraction: 0
    },
    exportHistory: [],
    lastUniformityMetrics: {
        nonUniformityPercent: 0,
        uniformityPercent: 100,
        centerThicknessNm: 0,
        edgeThicknessNm: 0,
        avgThicknessNm: 0
    },
    lastProcessDiagnostics: {
        scatteringRatio: 0,
        transportCode: 'BALLISTIC',
        uniformityCode: 'EXCELLENT',
        statusText: 'STABLE PROCESS'
    },
    devDiagnostics: {
        ionsSpawnedSec: 0,
        emittedPacketsSec: 0,
        landedPacketsSec: 0,
        depositedUnitsSec: 0,
        lastSecond: null
    },
    advisorRunTargetMs: null,
    advisorTargetThicknessNm: null,
    advisorAutoPauseMessage: '',
    thicknessTargetNm: null,
    thicknessTargetActive: false,
    thicknessTargetAchieved: false,
    reactiveState: {
        poisoning: [0, 0, 0],
        hysteresis: 0
    },

    // Simulation Scaling
    simSpeed: 1.0,
    particleDensity: 1.0,

    // Geometry
    distanceCM: 10,
    targetDiaInches: 3,
    subDiaInches: 4,

    // View Mode
    viewMode3D: true,
    numSources: 1,

    // New Features
    chartMode: 'time',
    isRunning: false,

    // Growth Mode Engine
    growthMode: 'auto',
    surfaceMobility: 0.5,
    latticeMismatch: 0.04,
    strainEnergy: 0.0,
    criticalThickness: 5.0,
    skPhase: 'layer'
};

// Arrays for entities
let ions = [];
let sputteredAtoms = [];
let substrateProfile = [];
let visualFilmProfile = [];
let layerMap = [];          // integer monolayer count per bin (FM / SK layer phase)
let nucleationSites = [];   // x-bin indices of VW island nucleation centres
// Maps reduced-order substrate-profile units to a classroom-friendly thickness scale.
// Calibrated so minute-scale runs land in a realistic thin-film nm range instead of
// staying artificially close to zero for long periods.
const THICKNESS_NM_PER_PROFILE_UNIT = 2.56;
const ION_SPAWN_SCALE_PER_FRAME = 0.30;
const SPUTTER_PACKET_SCALE = 140;
const MULTI_GUN_PACKET_NORM_EXP = 0.35;
const DEPOSITION_UNITS_PER_LANDING = 4.8;
const STARTUP_BURST_SCALE = 2.0;

function getActiveSources() {
    return STATE.sources.filter(src => src.active);
}

function getTotalActivePower() {
    return getActiveSources().reduce((sum, src) => sum + src.power, 0);
}

function getRepresentativePower() {
    const activeSources = getActiveSources();
    if (activeSources.length > 0) return activeSources[0].power;
    return STATE.sources[0] ? STATE.sources[0].power : STATE.power;
}

function updateVisualFilmProfile() {
    if (!visualFilmProfile || visualFilmProfile.length !== NUM_BINS) {
        visualFilmProfile = new Array(NUM_BINS).fill(0);
    }
    const response = STATE.isRunning && !STATE.paused ? 0.12 : 0.06;
    for (let i = 0; i < NUM_BINS; i++) {
        const target = Number.isFinite(substrateProfile[i]) ? substrateProfile[i] : 0;
        const current = Number.isFinite(visualFilmProfile[i]) ? visualFilmProfile[i] : 0;
        visualFilmProfile[i] = lerp(current, target, response);
    }
}

function syncDerivedPowerState() {
    const totalPower = getTotalActivePower();
    const representativePower = getRepresentativePower();
    STATE.power = totalPower > 0 ? totalPower : representativePower;
    const representativeIdx = Math.max(0, STATE.sources.findIndex(src => src.active && src.power >= 80));
    const discharge = getSourceDischarge(representativeIdx);
    STATE.representativeVoltage = discharge.voltage;
    STATE.representativeIonEnergy = discharge.ionEnergy;

    const ionEl = document.getElementById('ionEnergyVal');
    if (ionEl) {
        ionEl.textContent = Math.round(discharge.ionEnergy) + ' eV';
    }
}

function setChartMode(mode) {
    STATE.chartMode = mode === 'power' ? 'power' : 'time';

    const btnTime = document.getElementById('btn-chart-time');
    const btnPower = document.getElementById('btn-chart-power');
    if (btnTime && btnPower) {
        const activeBg = 'rgba(74,144,212,0.18)';
        const inactiveBg = 'var(--bg-section)';
        const activeColor = 'var(--accent-cyan)';
        const inactiveColor = 'var(--text-secondary)';

        btnTime.style.background = STATE.chartMode === 'time' ? activeBg : inactiveBg;
        btnTime.style.color = STATE.chartMode === 'time' ? activeColor : inactiveColor;
        btnPower.style.background = STATE.chartMode === 'power' ? activeBg : inactiveBg;
        btnPower.style.color = STATE.chartMode === 'power' ? activeColor : inactiveColor;
    }

    if (depChart) {
        depChart.options.scales.x.title.text = STATE.chartMode === 'power' ? 'Total Power (W)' : 'Time (s)';
        depChart.data.labels = [STATE.chartMode === 'power' ? Math.round(getTotalActivePower()) : 0];
        depChart.data.datasets.forEach(ds => ds.data = [0]);
        depChart.update();
    }
}

function computeMeanFreePathMeters() {
    const kB = 1.38e-23;
    const T = STATE.temperature;
    const dMix = (3.5e-10 * (1 - STATE.oxygenPercent / 100)) + (3.0e-10 * (STATE.oxygenPercent / 100));
    const P_pa = Math.max(0.1, STATE.pressure) * 0.133322;
    return (kB * T) / (Math.sqrt(2) * Math.PI * Math.pow(dMix, 2) * P_pa);
}

function getTransportFactor() {
    const lambda_m = computeMeanFreePathMeters();
    const path_m = Math.max(0.02, STATE.distanceCM / 100);
    return constrain(Math.exp(-path_m / Math.max(lambda_m, 1e-5)), 0.08, 1.0);
}

function calculateScatteringRatio(distanceMeters, meanFreePathMeters) {
    return distanceMeters / Math.max(meanFreePathMeters, 1e-6);
}

function classifyTransport(ratio) {
    if (ratio < 1) return "BALLISTIC";
    if (ratio < 2) return "MODERATE_SCATTERING";
    if (ratio < 3) return "HIGH_SCATTERING";
    return "STRONG_SCATTERING";
}

function classifyUniformity(uniformityPercent) {
    if (uniformityPercent === null || uniformityPercent === undefined || Number.isNaN(uniformityPercent)) return "CALCULATING";
    if (uniformityPercent >= 95) return "EXCELLENT";
    if (uniformityPercent >= 85) return "ACCEPTABLE";
    if (uniformityPercent >= 70) return "POOR";
    return "VERY_POOR";
}

function generateProcessStatus(ratio, uniformityPercent) {
    const transport = classifyTransport(ratio);
    const uniform = classifyUniformity(uniformityPercent);

    if (uniform === "CALCULATING") {
        if (transport === "HIGH_SCATTERING" || transport === "STRONG_SCATTERING") {
            return "HIGH GAS SCATTERING - CONSIDER LOWER PRESSURE";
        }
        return transport === "MODERATE_SCATTERING" ? "NORMAL MAGNETRON SPUTTERING REGIME" : "STABLE PROCESS";
    }

    if (transport === "BALLISTIC" && uniform === "EXCELLENT") {
        return "OPTIMAL SPUTTERING CONDITIONS";
    }
    if (transport === "MODERATE_SCATTERING" && uniform === "EXCELLENT") {
        return "NORMAL MAGNETRON SPUTTERING REGIME";
    }
    if (transport === "HIGH_SCATTERING" || transport === "STRONG_SCATTERING") {
        return "HIGH GAS SCATTERING - CONSIDER LOWER PRESSURE";
    }
    if (uniform === "POOR" || uniform === "VERY_POOR") {
        return "LOW FILM UNIFORMITY - CHECK GEOMETRY";
    }
    return "STABLE PROCESS";
}

function getTransportDisplayLabel(code) {
    const labels = {
        BALLISTIC: 'Ballistic transport',
        MODERATE_SCATTERING: 'Moderate scattering',
        HIGH_SCATTERING: 'High scattering',
        STRONG_SCATTERING: 'Strong scattering / diffusion dominated'
    };
    return labels[code] || code;
}

function getUniformityDisplayLabel(code) {
    const labels = {
        CALCULATING: 'Calculating...',
        EXCELLENT: 'Excellent',
        ACCEPTABLE: 'Acceptable',
        POOR: 'Poor',
        VERY_POOR: 'Very poor'
    };
    return labels[code] || code;
}

function toSuperscriptNumber(value) {
    const map = {
        '-': '⁻',
        '0': '⁰',
        '1': '¹',
        '2': '²',
        '3': '³',
        '4': '⁴',
        '5': '⁵',
        '6': '⁶',
        '7': '⁷',
        '8': '⁸',
        '9': '⁹'
    };
    return String(value).split('').map(ch => map[ch] || ch).join('');
}

function formatTorrScientific(value) {
    if (!Number.isFinite(value) || value <= 0) return '--';
    const exponent = Math.floor(Math.log10(value));
    const mantissa = value / Math.pow(10, exponent);
    return `${mantissa.toFixed(1)} × 10${toSuperscriptNumber(exponent)} Torr`;
}

function getDischargeStabilityWarning() {
    if (STATE.pressure >= 0.5) return '';
    return '⚠ Below typical magnetron discharge stability limit (~0.5 mTorr). Real discharges may extinguish at this pressure.';
}

function getDiagnosticTone(statusText, transportCode, uniformityCode) {
    if (uniformityCode === 'POOR' || uniformityCode === 'VERY_POOR') return 'red';
    if (transportCode === 'HIGH_SCATTERING' || transportCode === 'STRONG_SCATTERING') return 'orange';
    if (statusText === 'NORMAL MAGNETRON SPUTTERING REGIME') return 'yellow';
    return 'green';
}

function updateProcessDiagnostics(ratio, transportCode, uniformityPercent, uniformityCode, statusText) {
    const basePressureEl = document.getElementById('diag-base-pressure');
    const workingPressureEl = document.getElementById('diag-working-pressure');
    const ratioEl = document.getElementById('diag-ratio');
    const transportEl = document.getElementById('diag-transport');
    const transportWarningEl = document.getElementById('diag-transport-warning');
    const uniformityEl = document.getElementById('diag-uniformity');
    const processEl = document.getElementById('diag-process-status');
    const pillEl = document.getElementById('diag-status-pill');
    const centerEdgeEl = document.getElementById('diag-center-edge');
    const edgeFractionEl = document.getElementById('diag-edge-fraction');
    const histogramEl = document.getElementById('diag-histogram');
    const tone = getDiagnosticTone(statusText, transportCode, uniformityCode);
    const toneClass = `status-${tone}`;
    const landing = STATE.landingDiagnostics || { radialHistogram: [0, 0, 0, 0], centerEdgeRatio: 0, edgeFraction: 0 };
    const stabilityWarning = getDischargeStabilityWarning();

    if (basePressureEl) basePressureEl.textContent = formatTorrScientific(STATE.basePressureTorr);
    if (workingPressureEl) workingPressureEl.textContent = `${STATE.pressure.toFixed(1)} mTorr`;
    if (ratioEl) ratioEl.textContent = ratio.toFixed(2);
    if (transportEl) transportEl.textContent = getTransportDisplayLabel(transportCode);
    if (transportWarningEl) {
        transportWarningEl.textContent = stabilityWarning;
        transportWarningEl.style.display = stabilityWarning ? 'block' : 'none';
    }
    if (uniformityEl) uniformityEl.textContent = getUniformityDisplayLabel(uniformityCode);
    if (processEl) processEl.textContent = statusText;
    if (centerEdgeEl) centerEdgeEl.textContent = landing.centerEdgeRatio ? landing.centerEdgeRatio.toFixed(2) : '0.00';
    if (edgeFractionEl) edgeFractionEl.textContent = `${(landing.edgeFraction * 100).toFixed(1)}%`;
    if (histogramEl) histogramEl.textContent = landing.radialHistogram ? landing.radialHistogram.join(' / ') : '--';
    if (pillEl) {
        pillEl.textContent = tone === 'green' ? 'Stable' : tone === 'yellow' ? 'Normal' : tone === 'orange' ? 'Scatter' : 'Critical';
        pillEl.classList.remove('status-green', 'status-yellow', 'status-orange', 'status-red');
        pillEl.classList.add(toneClass);
    }

    STATE.lastProcessDiagnostics = {
        scatteringRatio: ratio,
        transportCode: transportCode,
        uniformityCode: uniformityCode,
        statusText: statusText
    };
}

function refreshProcessDiagnosticsFromState() {
    const lambda_m = computeMeanFreePathMeters();
    const distance_m = Math.max(0.02, STATE.distanceCM / 100);
    const scatteringRatio = calculateScatteringRatio(distance_m, lambda_m);
    const transportCode = classifyTransport(scatteringRatio);
    const uniformityPercent = STATE.lastUniformityMetrics
        ? STATE.lastUniformityMetrics.uniformityPercent : 100;
    const uniformityCode = classifyUniformity(uniformityPercent);
    const statusText = generateProcessStatus(scatteringRatio, uniformityPercent);
    updateProcessDiagnostics(scatteringRatio, transportCode, uniformityPercent, uniformityCode, statusText);
}

function getUniformityMetrics() {
    let rawThickness = substrateProfile.map(atoms => {
        const safeAtoms = Number.isFinite(atoms) ? atoms : 0;
        return safeAtoms * THICKNESS_NM_PER_PROFILE_UNIT;
    });
    let thicknessData = rawThickness.map(v => Number.isFinite(v) ? Math.min(v, 50) : 0);
    let subWpx = STATE.subDiaInches * (300 / 4);
    let subBins = Math.max(1, Math.floor(subWpx / BIN_SIZE));
    let c = Math.floor(NUM_BINS / 2);
    let start = Math.max(0, c - Math.floor(subBins / 2));
    let end = Math.min(NUM_BINS, c + Math.floor(subBins / 2));
    let subSlice = thicknessData.slice(start, end).filter(v => Number.isFinite(v));
    let centerThicknessNm = Number.isFinite(thicknessData[Math.floor(NUM_BINS / 2)]) ? thicknessData[Math.floor(NUM_BINS / 2)] : 0;
    let edgeLeft = subSlice.length > 0 ? subSlice[0] : 0;
    let edgeRight = subSlice.length > 1 ? subSlice[subSlice.length - 1] : edgeLeft;
    let edgeThicknessNm = Number.isFinite((edgeLeft + edgeRight) / 2.0) ? ((edgeLeft + edgeRight) / 2.0) : 0;
    let subSum = subSlice.reduce((a, b) => a + b, 0);
    let avgThicknessNm = subSlice.length > 0 ? subSum / subSlice.length : 0;
    let nonUniformityPercent = 0;
    let uniformityPercent = 100;

    if (timeSec < 10 && STATE.isRunning) {
        uniformityPercent = null;
    } else if (avgThicknessNm > 0 && subSlice.length > 0) {
        let maxT = Math.max(...subSlice);
        let minT = Math.min(...subSlice);
        nonUniformityPercent = ((maxT - minT) / avgThicknessNm) * 100;
        nonUniformityPercent = Math.max(0, Math.min(100, nonUniformityPercent));
        uniformityPercent = Math.max(0, Math.min(100, 100 - nonUniformityPercent));
    }

    return {
        rawThickness: rawThickness,
        thicknessData: thicknessData,
        centerThicknessNm: centerThicknessNm,
        edgeThicknessNm: edgeThicknessNm,
        avgThicknessNm: avgThicknessNm,
        nonUniformityPercent: nonUniformityPercent,
        uniformityPercent: uniformityPercent
    };
}

function recordExportSnapshot(metrics, scatteringRatio, transportCode, uniformityCode, statusText, efficiency) {
    STATE.exportHistory.push({
        timeSec: timeSec,
        totalPowerW: getTotalActivePower(),
        pressuremTorr: STATE.pressure,
        oxygenPercent: STATE.oxygenPercent,
        argonPercent: STATE.argonPercent,
        temperatureK: STATE.temperature,
        magneticFieldT: STATE.magField,
        distanceCm: STATE.distanceCM,
        targetDiaIn: STATE.targetDiaInches,
        substrateDiaIn: STATE.subDiaInches,
        activeGuns: getActiveSources().map(src => src.material).join('+') || 'None',
        modes: getActiveSources().map(src => src.powerType).join('/') || 'None',
        depositionRateAtomsPerS: STATE.depositThisSecond,
        totalDepositedAtoms: STATE.totalDeposited,
        sputteringYield: STATE.yield,
        illustrativeYield: STATE.illustrativeYield,
        meanFreePathCm: computeMeanFreePathMeters() * 100,
        scatteringRatio: scatteringRatio,
        transportRegime: getTransportDisplayLabel(transportCode),
        representativeVoltageV: STATE.representativeVoltage,
        totalCurrentA: STATE.totalCurrent,
        ionEnergyEV: STATE.representativeIonEnergy,
        transportFactor: STATE.transportFactor,
        stickingCoeff: STATE.stickingCoeff,
        reactiveHysteresis: STATE.reactiveState.hysteresis,
        poisoningGun1: STATE.reactiveState.poisoning[0] || 0,
        poisoningGun2: STATE.reactiveState.poisoning[1] || 0,
        poisoningGun3: STATE.reactiveState.poisoning[2] || 0,
        centerThicknessNm: metrics.centerThicknessNm,
        edgeThicknessNm: metrics.edgeThicknessNm,
        avgThicknessNm: metrics.avgThicknessNm,
        nonUniformityPercent: metrics.nonUniformityPercent,
        uniformityPercent: metrics.uniformityPercent,
        uniformityClass: getUniformityDisplayLabel(uniformityCode),
        centerEdgeRatio: STATE.landingDiagnostics.centerEdgeRatio,
        edgeLandingFraction: STATE.landingDiagnostics.edgeFraction,
        filmMix: Object.entries(STATE.filmComposition).map(([mat, frac]) => `${mat}:${frac}`).join(';'),
        processStatus: statusText,
        efficiencyAtomsPerW: efficiency
    });
}

function getPowerTypeModifiers(powerType) {
    if (powerType === 'RF') {
        return {
            ionEnergy: 0.60,
            ionFlux: 0.65,
            sticking: 0.97
        };
    }
    return {
        ionEnergy: 1.06,
        ionFlux: 1.0,
        sticking: 1.0
    };
}

function estimateDischargeForSource(src, sourceIdx = 0) {
    const safeSrc = src || STATE.sources[sourceIdx] || STATE.sources[0];
    const matProps = MATERIALS[safeSrc.material] || MATERIALS.Cu;
    const typeMods = getPowerTypeModifiers(safeSrc.powerType || 'DC');
    const pressureShift = constrain((12 - STATE.pressure) * 4.5, -60, 55);
    const powerShift = Math.sqrt(Math.max(safeSrc.power, 0)) * 9;
    const oxygenShift = (STATE.oxygenPercent / 100) * 55;
    const magneticRelief = constrain((STATE.magField - 0.03) / 0.09, -0.4, 1.0) * 26;
    const materialShift = constrain((matProps.Eb - 3.5) * 16, -24, 52);
    const baseVoltage = safeSrc.powerType === 'RF' ? 300 : 360;
    const voltage = constrain(baseVoltage + pressureShift + powerShift + oxygenShift + materialShift - magneticRelief, 220, 720);
    const current = safeSrc.power > 0 ? (safeSrc.power / voltage) : 0;
    const ionCurrent = current * 0.62 * typeMods.ionFlux;
    const ionEnergy = voltage * typeMods.ionEnergy * constrain(0.9 + (STATE.magField / 0.12) * 0.06, 0.88, 1.02);
    return { voltage, current, ionCurrent, ionEnergy };
}

function getSourceDischarge(sourceIdx = 0) {
    const src = STATE.sources[sourceIdx] || STATE.sources[0];
    if (!src) return { voltage: 320, current: 0, ionCurrent: 0, ionEnergy: 320 };
    if (!src.discharge) src.discharge = estimateDischargeForSource(src, sourceIdx);
    return src.discharge;
}

function getMaterialProps(matKey) {
    return MATERIALS[(matKey && MATERIALS[matKey]) ? matKey : STATE.material] || MATERIALS.Cu;
}

function getProjectileTargetGamma(targetMass) {
    const m1 = PROJECTILE_AR.mass;
    const m2 = Math.max(1, targetMass);
    return (4 * m1 * m2) / Math.pow(m1 + m2, 2);
}

function getReducedEnergyScale(targetZ) {
    const z1 = PROJECTILE_AR.Z;
    const z2 = Math.max(1, targetZ || 29);
    return z1 * z2 * (Math.pow(z1, 0.23) + Math.pow(z2, 0.23));
}

function getUniversalStoppingTerm(ionEnergyEV, matProps) {
    const gamma = getProjectileTargetGamma(matProps.mass);
    const z1 = PROJECTILE_AR.Z;
    const z2 = Math.max(1, matProps.Z || 29);
    const scale = getReducedEnergyScale(matProps.Z);
    const eps = Math.max(1e-6, (32.53 * gamma * Math.max(ionEnergyEV, 0.1)) / Math.max(25, scale));
    const sn = (3.441 * Math.sqrt(eps) * Math.log(eps + Math.E)) /
        (1 + 6.355 * Math.sqrt(eps) + eps * (6.882 * Math.sqrt(eps) - 1.708));
    return Math.max(0, sn);
}

function estimateIonIncidenceAngleRadians(sourceIdx = 0) {
    const src = STATE.sources[sourceIdx] || STATE.sources[0];
    const pressureScatter = constrain(STATE.pressure / 24, 0, 1.1);
    const magneticTilt = constrain((STATE.magField - 0.03) / 0.05, -0.3, 0.8);
    const rfTilt = src && src.powerType === 'RF' ? 0.06 : 0.03;
    const distanceTilt = constrain((STATE.distanceCM - 8) / 12, 0, 1) * 0.08;
    const theta = 0.04 + pressureScatter * 0.08 + magneticTilt * 0.04 + rfTilt + distanceTilt;
    return constrain(theta, 0.02, radians(24));
}

function getYamamuraAngleFactor(thetaRad, matProps) {
    const theta = constrain(Math.abs(thetaRad || 0), 0, radians(70));
    const cosTheta = Math.max(0.18, Math.cos(theta));
    const f = matProps.angleShape || 1.6;
    const peakAngle = radians(62);
    const shapeBoost = Math.pow(cosTheta, -f);
    const damping = Math.exp(-f * (1 / cosTheta - 1) * Math.cos(peakAngle));
    return constrain(shapeBoost * damping, 0.82, 2.35);
}

function calculateYamamuraYield(ionEnergyEV, matProps, thetaRad = 0) {
    const U0 = Math.max(0.8, matProps.U0 || matProps.Eb || 3);
    const Eth = Math.max(8, matProps.Eth || U0 * 6.5);
    if (ionEnergyEV <= Eth) return 0;

    const sn = getUniversalStoppingTerm(ionEnergyEV, matProps);
    const q = matProps.yamQ || 0.1;
    const lowEnergyTerm = Math.max(0, 1 - Math.pow(Eth / ionEnergyEV, 2 / 3));
    const thresholdTail = Math.max(0.08, 1 - Eth / ionEnergyEV);
    const normalIncidenceYield = q * (sn / U0) * lowEnergyTerm * Math.pow(thresholdTail, 2);
    const angleFactor = getYamamuraAngleFactor(thetaRad, matProps);
    return Math.max(0, normalIncidenceYield * angleFactor);
}

function sampleCosineEmissionAngle(sourceIdx = 0) {
    const discharge = getSourceDischarge(sourceIdx);
    const src = STATE.sources[sourceIdx] || STATE.sources[0];
    const energyNorm = constrain(discharge.ionEnergy / 500, 0.2, 1.5);
    const pressureSoftening = constrain(STATE.pressure / 25, 0, 1.1);
    const rfSpread = src && src.powerType === 'RF' ? 0.25 : 0;
    const distanceFactor = constrain((STATE.distanceCM - 6) / 8, 0, 1.2);
    const targetFactor = constrain((STATE.targetDiaInches - 3) / 2, -0.5, 1.0);
    const coverageFactor = constrain(STATE.targetDiaInches / Math.max(0.1, STATE.subDiaInches), 0.55, 1.35);
    const geometrySoftening = Math.max(0, coverageFactor - 0.75) * 1.15 + Math.max(0, targetFactor) * 0.55;
    const shape = constrain(2.15 + energyNorm * 1.45 - pressureSoftening - rfSpread - distanceFactor * 0.6 - targetFactor * 0.75 - geometrySoftening, 0.55, 4.6);
    const u = random();
    const theta = Math.acos(Math.pow(1 - u, 1 / (shape + 1)));
    const signedTheta = random() < 0.5 ? -theta : theta;
    return -Math.PI / 2 + signedTheta;
}

function sampleThompsonLikeEnergy(sourceIdx = 0) {
    const src = STATE.sources[sourceIdx] || STATE.sources[0];
    const matProps = MATERIALS[(src && src.material) || STATE.material] || MATERIALS.Cu;
    const discharge = getSourceDischarge(sourceIdx);
    const ub = Math.max(1.0, matProps.Eb);
    const u = constrain(random(), 1e-4, 0.985);
    const reducedEnergy = discharge.ionEnergy / Math.max(120, discharge.ionEnergy + 180);
    const raw = ub * (u / (1 - u)) * (0.55 + reducedEnergy * 0.9);
    return constrain(raw, 1.5, 24);
}

function getIonSpawnRatePerFrame(sourceIdx = 0) {
    const discharge = getSourceDischarge(sourceIdx);
    const src = STATE.sources[sourceIdx] || STATE.sources[0];
    const pressurePenalty = constrain(1.05 - STATE.pressure / 42, 0.35, 1.05);
    const magneticBoost = constrain(0.85 + (STATE.magField / 0.12) * 0.25, 0.75, 1.15);
    const typeBoost = src && src.powerType === 'RF' ? 1.06 : 1.0;
    return constrain(discharge.ionCurrent * ION_SPAWN_SCALE_PER_FRAME * 2.25 * pressurePenalty * magneticBoost * typeBoost * STATE.particleDensity, 0.03, 1.6);
}

function resetLandingDiagnostics() {
    STATE.landingDiagnostics = {
        totalLandings: 0,
        centerLandings: 0,
        edgeLandings: 0,
        radialHistogram: [0, 0, 0, 0],
        centerEdgeRatio: 0,
        edgeFraction: 0
    };
}

function recordLandingDiagnostic(x) {
    const subWidthPx = STATE.subDiaInches * (300 / 4);
    const centerX = CANVAS_W / 2;
    const radiusNorm = Math.min(1, Math.abs(x - centerX) / Math.max(1, subWidthPx / 2));
    const diag = STATE.landingDiagnostics || (STATE.landingDiagnostics = {});
    if (!diag.radialHistogram) diag.radialHistogram = [0, 0, 0, 0];
    const bucket = Math.min(3, Math.floor(radiusNorm * 4));
    diag.radialHistogram[bucket] += 1;
    diag.totalLandings += 1;
    if (radiusNorm <= 0.25) diag.centerLandings += 1;
    if (radiusNorm >= 0.7) diag.edgeLandings += 1;
    diag.centerEdgeRatio = diag.edgeLandings > 0 ? (diag.centerLandings / diag.edgeLandings) : diag.centerLandings;
    diag.edgeFraction = diag.totalLandings > 0 ? (diag.edgeLandings / diag.totalLandings) : 0;
}

function getDepositionKernelSigmaPx(sourceIdx = 0, x = CANVAS_W / 2) {
    const lambda_m = computeMeanFreePathMeters();
    const distance_m = Math.max(0.02, STATE.distanceCM / 100);
    const ratio = calculateScatteringRatio(distance_m, lambda_m);
    const targetWidthPx = STATE.targetDiaInches * (120 / 3);
    const substrateWidthPx = STATE.subDiaInches * (300 / 4);
    const matchedCoverage = constrain(STATE.targetDiaInches / Math.max(0.1, STATE.subDiaInches), 0.55, 1.35);
    const ballisticSpread = Math.tan(0.22 + ratio * 0.08) * distance_m * (CANVAS_W / 0.20);
    const targetSpread = targetWidthPx * (0.22 + matchedCoverage * 0.20);
    const pressureSpread = substrateWidthPx * constrain(ratio * 0.085, 0.05, 0.34);
    const coverageBoost = substrateWidthPx * Math.max(0, matchedCoverage - 0.88) * 0.26;
    const edgeAssist = Math.abs(x - CANVAS_W / 2) / Math.max(1, substrateWidthPx / 2);
    return constrain(ballisticSpread + targetSpread + pressureSpread + coverageBoost + edgeAssist * 8, BIN_SIZE * 1.1, substrateWidthPx * 0.42);
}

function depositWithKernel(x, depositedAmount, densityScale, sourceIdx = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(depositedAmount) || !Number.isFinite(densityScale)) {
        return { bin: constrain(floor(CANVAS_W / 2 / BIN_SIZE), 0, NUM_BINS - 1), sigmaBins: 1.0 };
    }
    const centerX = CANVAS_W / 2;
    const substrateWidthPx = STATE.subDiaInches * (300 / 4);
    const targetWidthPx = STATE.targetDiaInches * (120 / 3);
    const subLeft = centerX - substrateWidthPx / 2;
    const subRight = centerX + substrateWidthPx / 2;
    const subLeftBin = Math.max(0, Math.floor(subLeft / BIN_SIZE));
    const subRightBin = Math.min(NUM_BINS - 1, Math.ceil(subRight / BIN_SIZE));
    const matchedCoverage = constrain(STATE.targetDiaInches / Math.max(0.1, STATE.subDiaInches), 0.55, 1.35);
    const sigmaPx = getDepositionKernelSigmaPx(sourceIdx, x);
    const scatteringRatio = calculateScatteringRatio(Math.max(0.02, STATE.distanceCM / 100), computeMeanFreePathMeters());
    const pressureFactor = constrain(scatteringRatio / 2.0, 0.2, 2.4);
    const activeSources = getActiveSources();
    const activeCount = Math.max(1, activeSources.length);
    const positionedGunX = STATE.gunPositions && Number.isFinite(STATE.gunPositions[sourceIdx])
        ? STATE.gunPositions[sourceIdx]
        : null;
    const sourceCenterX = positionedGunX !== null ? positionedGunX : centerX;
    const effectiveCenterX = lerp(sourceCenterX, x, activeCount >= 3 ? 0.18 : 0.10);
    const coreSigmaPx = constrain(
        sigmaPx * (1.25 + matchedCoverage * 0.28) + substrateWidthPx * (activeCount >= 3 ? 0.15 : 0.10) + pressureFactor * 8,
        substrateWidthPx * 0.18,
        substrateWidthPx * (activeCount >= 3 ? 0.56 : 0.46)
    );
    const shoulderSigmaPx = Math.max(BIN_SIZE * 3.0, coreSigmaPx * (activeCount >= 3 ? 1.10 : 0.95));
    const ringOffsetPx = targetWidthPx * constrain(0.18 + matchedCoverage * 0.16, 0.22, 0.38);
    const diffuseFloor = 0.08 + Math.max(0, matchedCoverage - 0.75) * 0.12 + (activeCount >= 3 ? 0.10 : 0);
    const baseBin = constrain(floor(effectiveCenterX / BIN_SIZE), 0, NUM_BINS - 1);
    let weightSum = 0;
    let weighted = [];
    if (!STATE.landingDiagnostics) resetLandingDiagnostics();
    const diag = STATE.landingDiagnostics;

    for (let idx = subLeftBin; idx <= subRightBin; idx++) {
        const binX = idx * BIN_SIZE + BIN_SIZE * 0.5;
        const dx = binX - effectiveCenterX;
        const coreWeight = Math.exp(-0.5 * Math.pow(Math.abs(dx) / Math.max(1, coreSigmaPx), 2.2));
        const shoulderWeight =
            0.30 * Math.exp(-0.5 * Math.pow((dx - ringOffsetPx) / Math.max(1, shoulderSigmaPx), 2)) +
            0.30 * Math.exp(-0.5 * Math.pow((dx + ringOffsetPx) / Math.max(1, shoulderSigmaPx), 2));
        const edgeNorm = Math.min(1, Math.abs(binX - centerX) / Math.max(1, substrateWidthPx / 2));
        const edgeAssist =
            Math.max(0, matchedCoverage - 0.82) * edgeNorm * (activeCount >= 3 ? 0.42 : 0.28) +
            edgeNorm * (activeCount >= 3 ? 0.10 : 0.04);
        const weight = coreWeight + shoulderWeight + diffuseFloor + edgeAssist;
        if (!Number.isFinite(weight) || weight <= 0) continue;
        weighted.push({ idx, weight, binX, sourceIdx });
        weightSum += weight;
    }

    if (weightSum <= 0) return { bin: baseBin, sigmaBins: Math.max(0.8, coreSigmaPx / BIN_SIZE) };

    for (const item of weighted) {
        const fraction = item.weight / weightSum;
        if (!Number.isFinite(fraction) || fraction <= 0) continue;
        const srcYield = (STATE.sources[item.sourceIdx]
            && STATE.sources[item.sourceIdx].yield)
            ? STATE.sources[item.sourceIdx].yield
            : (STATE.yield || 1.0);

        const yieldMult = Math.max(0.15,
            Math.min(3.5, srcYield / 1.5));

//        const contribution = depositedAmount * fraction * yieldMult;
        const contribution = depositedAmount * fraction;
        if (!contribution || contribution <= 0) return;
        if (!Number.isFinite(contribution) || contribution <= 0) continue;
        if (substrateProfile[item.idx] === undefined)
            substrateProfile[item.idx] = 0;
        const _depScaleMap = {
            'Cu': 1.00, 'Al': 1.00, 'Ti': 1.00,
            'Zn': 0.40, 'Sn': 0.85, 'W': 0.70,
            'Ta': 0.65, 'Mo': 0.80
        };

        const _depSrc = STATE.sources &&
            item.sourceIdx !== undefined
            ? STATE.sources[item.sourceIdx] : null;
        const _depMat = _depSrc
            ? (_depSrc.material || 'Cu') :
            (STATE.material || 'Cu');
        const _depMult = _depScaleMap[_depMat] || 1.0;

        substrateProfile[item.idx] = Math.min(substrateProfile[item.idx] + contribution * _depMult, 2000);
        layerMap[item.idx] = Math.floor(substrateProfile[item.idx] / 40);

        const radiusNorm = Math.min(1, Math.abs(item.binX - centerX) / Math.max(1, substrateWidthPx / 2));
        if (!diag.radialHistogram) diag.radialHistogram = [0, 0, 0, 0];
        const bucket = Math.min(3, Math.floor(radiusNorm * 4));
        diag.radialHistogram[bucket] += fraction;
        diag.totalLandings += fraction;
        if (radiusNorm <= 0.25) diag.centerLandings += fraction;
        if (radiusNorm >= 0.7) diag.edgeLandings += fraction;
    }

    diag.centerEdgeRatio = diag.edgeLandings > 0 ? (diag.centerLandings / diag.edgeLandings) : diag.centerLandings;
    diag.edgeFraction = diag.totalLandings > 0 ? (diag.edgeLandings / diag.totalLandings) : 0;
    return { bin: baseBin, sigmaBins: Math.max(0.8, coreSigmaPx / BIN_SIZE) };
}

function depositLocalNeighborhood(centerBin, depositedAmount, densityScale, radiusBins, sharpness = 1.0) {
    const safeRadius = Math.max(1, Math.round(radiusBins));
    let weightSum = 0;
    const weights = [];
    for (let offset = -safeRadius; offset <= safeRadius; offset++) {
        const idx = centerBin + offset;
        if (idx < 0 || idx >= NUM_BINS) continue;
        const norm = Math.abs(offset) / Math.max(1, safeRadius);
        const weight = Math.exp(-sharpness * norm * norm * 3.0);
        weights.push({ idx, weight });
        weightSum += weight;
    }
    if (weightSum <= 0) return;

    const totalContribution = Math.max(0, depositedAmount);
    for (const item of weights) {
        const contribution = totalContribution * (item.weight / weightSum);
        substrateProfile[item.idx] = Math.min(substrateProfile[item.idx] + contribution, 2000);
        layerMap[item.idx] = Math.floor(substrateProfile[item.idx] / 40);
    }
}

function updateReactiveState() {
    const oxygenFrac = STATE.oxygenPercent / 100;
    let activeRF = 0;
    let activePower = 0;

    STATE.sources.forEach((src, idx) => {
        if (!src.active) {
            STATE.reactiveState.poisoning[idx] *= 0.992;
            return;
        }

        const powerNorm = constrain((src.power - 80) / 420, 0, 1);
        const rfBias = src.powerType === 'RF' ? 1.08 : 0.96;
        const poisoningDrive = oxygenFrac * rfBias * (1.12 - powerNorm * 0.55);
        const sputterCleaning = powerNorm * (src.powerType === 'DC' ? 0.060 : 0.045);
        STATE.reactiveState.poisoning[idx] = constrain(
            (STATE.reactiveState.poisoning[idx] || 0) * 0.985 + poisoningDrive * 0.045 - sputterCleaning * 0.018,
            0,
            0.92
        );

        activePower += src.power;
        if (src.powerType === 'RF') activeRF++;
    });

    const powerNormTotal = constrain(activePower / 1200, 0, 1);
    const rfAssist = activeRF > 0 ? 0.06 : 0;
    STATE.reactiveState.hysteresis = constrain(
        STATE.reactiveState.hysteresis * 0.97 + oxygenFrac * 0.12 + rfAssist - powerNormTotal * 0.05,
        0,
        1
    );
}

function getStickingCoefficient(sourceIdx, energy = 5) {
    const src = STATE.sources[sourceIdx] || STATE.sources[0];
    const typeMods = getPowerTypeModifiers(src ? src.powerType : 'DC');
    const oxygenFrac = STATE.oxygenPercent / 100;
    const thermalTerm = constrain(1.0 - (STATE.temperature - 300) / 900, 0.55, 1.02);
    const energyTerm = constrain(0.72 + Math.sqrt(Math.max(energy, 0.1)) * 0.07, 0.72, 1.05);
    const poisonPenalty = 1.0 - ((STATE.reactiveState.poisoning[sourceIdx] || 0) * 0.22);
    return constrain(0.82 * thermalTerm * energyTerm * typeMods.sticking * (1.0 - oxygenFrac * 0.08) * poisonPenalty, 0.35, 0.96);
}

function updateCompositionState() {
    const total = STATE.sources.reduce((sum, src) => sum + (src.deposited || 0), 0);
    const composition = {};
    STATE.sources.forEach(src => {
        if (!src.active && !src.deposited) return;
        composition[src.material] = (composition[src.material] || 0) + (src.deposited || 0);
    });
    STATE.filmComposition = composition;
    return total;
}

function positionChamberLabels() {
    const labels = [
        { el: document.getElementById('lbl-substrate'), top: SUBSTRATE_Y - 18, opacity: 1.0 },
        { el: document.getElementById('lbl-gas'), top: SUBSTRATE_Y + (TARGET_Y - SUBSTRATE_Y) * 0.30, opacity: 0.95 },
        { el: document.getElementById('lbl-plasma'), top: SUBSTRATE_Y + (TARGET_Y - SUBSTRATE_Y) * 0.66, opacity: 0.98 },
        { el: document.getElementById('lbl-target'), top: TARGET_Y - 18, opacity: 1.0 }
    ].filter(item => item.el);

    const leftInset = CHAMBER_ML + WALL_W + 10;
    const minTop = WALL_W + 12;
    const maxTop = Math.max(minTop, TARGET_Y - 44);
    const minGap = 48;

    labels.forEach(item => {
        item.top = constrain(item.top, minTop, maxTop);
    });

    for (let i = 1; i < labels.length; i++) {
        if (labels[i].top < labels[i - 1].top + minGap) {
            labels[i].top = labels[i - 1].top + minGap;
        }
    }

    for (let i = labels.length - 2; i >= 0; i--) {
        if (labels[i].top > labels[i + 1].top - minGap) {
            labels[i].top = labels[i + 1].top - minGap;
        }
    }

    labels.forEach(item => {
        item.el.style.left = leftInset + 'px';
        item.el.style.top = constrain(item.top, minTop, maxTop) + 'px';
        item.el.style.opacity = String(item.opacity);
    });
}

function updateRecipeSummary() {
    const activeSources = getActiveSources();
    const activeGunsEl = document.getElementById('recipe-active-guns');
    const materialsEl = document.getElementById('recipe-materials');
    const modesEl = document.getElementById('recipe-modes');
    const totalPowerEl = document.getElementById('recipe-total-power');
    const pressureEl = document.getElementById('recipe-pressure');
    const compositionEl = document.getElementById('recipe-composition');
    const statusPill = document.getElementById('recipe-status-pill');
    const modelTag = document.getElementById('physics-model-tag');
    const depositedTotal = updateCompositionState();

    if (activeGunsEl) activeGunsEl.textContent = activeSources.length ? activeSources.map(src => `Gun ${STATE.sources.indexOf(src) + 1}`).join(', ') : 'None active';
    if (materialsEl) materialsEl.textContent = activeSources.length ? activeSources.map(src => src.material).join(' + ') : '--';
    if (modesEl) modesEl.textContent = activeSources.length ? activeSources.map(src => src.powerType).join(' / ') : '--';
    if (totalPowerEl) totalPowerEl.textContent = `${getTotalActivePower()} W`;
    if (pressureEl) pressureEl.textContent = `${STATE.pressure} mTorr`;
    if (compositionEl) {
        if (!depositedTotal) {
            compositionEl.textContent = '--';
        } else {
            const compText = Object.entries(STATE.filmComposition)
                .sort((a, b) => b[1] - a[1])
                .map(([mat, amount]) => `${mat} ${((amount / depositedTotal) * 100).toFixed(0)}%`)
                .join(' | ');
            compositionEl.textContent = compText || '--';
        }
    }
    if (statusPill) {
        statusPill.textContent = STATE.isRunning ? (STATE.paused ? 'Paused' : 'Running') : (activeSources.length ? 'Ready' : 'Idle');
        statusPill.style.color = STATE.isRunning ? 'var(--accent-green)' : activeSources.length ? 'var(--accent-cyan)' : 'var(--accent-yellow)';
    }
    if (modelTag) {
        modelTag.textContent = `Reduced-order | V=${STATE.representativeVoltage.toFixed(0)} V | I=${STATE.totalCurrent.toFixed(2)} A | T=${(STATE.transportFactor * 100).toFixed(0)}%`;
    }
}

function updateStartGuidance(forceError = false) {
    const warn = document.getElementById('start-warning');
    if (!warn) return;

    const readySources = STATE.sources.filter(src => src.active && src.power >= 80);
    warn.classList.remove('is-error', 'is-info');

    if (STATE.isRunning) {
        warn.style.display = 'none';
        return;
    }

    if (forceError || readySources.length === 0) {
        warn.innerHTML = 'Enable at least one gun at <strong>80 W or above</strong> to start the process.';
        warn.classList.add(forceError ? 'is-error' : 'is-info');
        return;
    }

    warn.innerHTML = `Ready to start with <strong>${readySources.length}</strong> active gun${readySources.length > 1 ? 's' : ''}.`;
    warn.classList.add('is-info');
}

function updateThicknessTargetUI() {
    const currentThickness = (STATE.lastUniformityMetrics && Number.isFinite(STATE.lastUniformityMetrics.avgThicknessNm))
        ? STATE.lastUniformityMetrics.avgThicknessNm
        : 0;
    const statusEl = document.getElementById('thickness-target-status');

    if (STATE.thicknessTargetNm === null || STATE.thicknessTargetActive === false) {
        if (statusEl) statusEl.style.display = 'none';
        return;
    }

    if (statusEl) statusEl.style.display = 'block';

    const targetValEl = document.getElementById('tt-target-val');
    const currentValEl = document.getElementById('tt-current-val');
    const remainingValEl = document.getElementById('tt-remaining-val');
    const progressBarEl = document.getElementById('tt-progress-bar');

    if (targetValEl) targetValEl.textContent = STATE.thicknessTargetNm.toFixed(1) + ' nm';
    if (currentValEl) currentValEl.textContent = currentThickness.toFixed(2) + ' nm';

    const remaining = Math.max(0, STATE.thicknessTargetNm - currentThickness);
    if (remainingValEl) remainingValEl.textContent = remaining.toFixed(2) + ' nm';

    const progressPct = Math.min(100, (currentThickness / STATE.thicknessTargetNm) * 100);
    if (progressBarEl) {
        progressBarEl.style.width = progressPct + '%';
        progressBarEl.style.background = progressPct >= 100
            ? 'var(--accent-green)'
            : progressPct >= 70
                ? 'var(--accent-yellow)'
                : 'var(--accent-cyan)';
    }

    if (progressPct >= 100 && STATE.thicknessTargetAchieved === false) {
        STATE.thicknessTargetAchieved = true;
        STATE.isRunning = false;
        STATE.paused = true;
        _timerPause();
        _updateStartBtnUI();
        noLoop();
        const achievedEl = document.getElementById('thickness-target-achieved');
        if (achievedEl) achievedEl.style.display = 'block';
        const achievedSummaryEl = document.getElementById('tt-achieved-summary');
        if (achievedSummaryEl) {
            achievedSummaryEl.innerHTML =
                'Thickness: ' + currentThickness.toFixed(2) + ' nm<br>' +
                'Time: ' + timeSec + ' s<br>' +
                'Uniformity: ' + ((STATE.lastUniformityMetrics.uniformityPercent || 0).toFixed(1)) + '%<br>' +
                'Avg rate: ' + STATE.effectiveDepositionRate.toFixed(1) + ' atoms/s';
        }
        if (statusEl) statusEl.style.display = 'none';
    }
}

function exportFigure3Data() {
    const pressuresMTorr = [1.5, 5, 12, 25];
    const radialPositionsMm = Array.from({ length: 81 }, (_, i) => -80 + (i * 2));
    const originalState = JSON.parse(JSON.stringify(STATE));
    const originalTimeSec = timeSec;
    const originalSubstrateProfile = Array.isArray(substrateProfile) ? substrateProfile.slice() : [];
    const originalVisualFilmProfile = Array.isArray(visualFilmProfile) ? visualFilmProfile.slice() : [];
    const originalLayerMap = Array.isArray(layerMap) ? layerMap.slice() : [];
    const originalNucleationSites = Array.isArray(nucleationSites) ? nucleationSites.slice() : [];
    const originalDepChartData = depChart ? JSON.parse(JSON.stringify(depChart.data)) : null;

    const sampleProfileFromSubstrate = () => {
        const hasProfile = Array.isArray(substrateProfile)
            && substrateProfile.length === NUM_BINS
            && substrateProfile.some(v => Number.isFinite(v) && v > 0);
        if (!hasProfile) return null;

        const centerPx = CANVAS_W / 2;
        const substrateWidthPx = STATE.subDiaInches * (300 / 4);
        const substrateRadiusPx = substrateWidthPx / 2;
        const substrateRadiusMm = Math.max(1e-6, STATE.subDiaInches * 25.4 / 2);
        const sampled = radialPositionsMm.map((posMm) => {
            const normalized = constrain(posMm / substrateRadiusMm, -1, 1);
            const posPx = centerPx + normalized * substrateRadiusPx;
            const bin = constrain(Math.round(posPx / BIN_SIZE), 0, NUM_BINS - 1);
            const value = substrateProfile[bin];
            return Number.isFinite(value) ? Math.max(0, value) : 0;
        });
        const peak = Math.max(...sampled, 0);
        if (peak <= 0) return null;
        return sampled.map(v => +(v / peak).toFixed(6));
    };

    const buildGaussianProfile = (chi) => {
        const sigmaGeom = (STATE.targetDiaInches * 25.4 / 2) * 0.45;
        const sigmaScatter = (STATE.targetDiaInches * 25.4 / 2) * 0.55 * Math.tanh(chi * 0.9);
        const sigmaTotal = Math.sqrt((sigmaGeom ** 2) + (sigmaScatter ** 2));
        const safeSigma = Math.max(1e-6, sigmaTotal);
        const values = radialPositionsMm.map((xMm) => Math.exp(-((xMm ** 2) / (2 * safeSigma ** 2))));
        const peak = Math.max(...values, 1e-6);
        return values.map(v => +(v / peak).toFixed(6));
    };

    try {
        STATE.thicknessTargetActive = false;
        STATE.advisorRunTargetMs = null;
        STATE.material = 'Cu';
        STATE.sources[0].material = 'Cu';
        STATE.sources[0].power = 300;
        STATE.sources[0].powerType = 'DC';
        STATE.sources[0].active = true;
        STATE.sources[1].active = false;
        STATE.sources[2].active = false;
        STATE.targetDiaInches = 3;
        STATE.subDiaInches = 3;
        STATE.substrateDiaInches = 3;
        STATE.distanceCM = 10;
        STATE.targetSubstrateDist = 10;
        STATE.argonPercent = 100;
        STATE.oxygenPercent = 0;
        STATE.o2Fraction = 0;
        STATE.temperature = 300;
        STATE.numSources = 1;

        const runs = pressuresMTorr.map((pressureMTorr) => {
            STATE.pressure = pressureMTorr;
            updateChart();

            const lambdaMeters = computeMeanFreePathMeters();
            const lambdaCm = lambdaMeters * 100;
            const distanceCm = Number.isFinite(STATE.targetSubstrateDist) ? STATE.targetSubstrateDist : STATE.distanceCM;
            const chi = distanceCm / Math.max(lambdaCm, 1e-6);
            const transportLabel = getTransportDisplayLabel(
                (STATE.lastProcessDiagnostics && STATE.lastProcessDiagnostics.transportCode)
                || classifyTransport(chi)
            );
            const profileFromState = sampleProfileFromSubstrate();
            const normalisedThickness = profileFromState || buildGaussianProfile(chi);

            return {
                pressureMTorr: pressureMTorr,
                lambdaCm: +lambdaCm.toFixed(6),
                chi: +chi.toFixed(6),
                nuPercent: +((STATE.lastUniformityMetrics.uniformityPercent || 0)).toFixed(6),
                transportLabel: transportLabel,
                yield: +(Number(STATE.yield) || 0).toFixed(6),
                depositionRate: +(Number(STATE.effectiveDepositionRate) || 0).toFixed(6),
                radialPositionsMm: radialPositionsMm.slice(),
                normalisedThickness: normalisedThickness
            };
        });

        const figure3Data = {
            metadata: {
                targetMaterial: 'Cu',
                powerW: 300,
                targetDiaInches: 3,
                substrateDiaInches: 3,
                distanceCm: 10,
                gasMixture: 'Pure Ar',
                temperatureK: 300
            },
            runs: runs
        };

        const blob = new Blob([JSON.stringify(figure3Data, null, 2)], { type: 'application/json;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", 'SputterOne_Figure3_Data.json');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    } finally {
        STATE = originalState;
        timeSec = originalTimeSec;
        substrateProfile = originalSubstrateProfile.slice();
        visualFilmProfile = originalVisualFilmProfile.slice();
        layerMap = originalLayerMap.slice();
        nucleationSites = originalNucleationSites.slice();

        if (depChart && originalDepChartData) {
            depChart.data.labels = originalDepChartData.labels;
            depChart.data.datasets = originalDepChartData.datasets;
            depChart.update('none');
        }

        updateThicknessTargetUI();
        updateStartGuidance();
        updateRecipeSummary();
    }
}

function updateControlRelevance() {
    const latticeMismatchSlider = document.getElementById('latticeMismatchSlider');
    const latticeGroup = latticeMismatchSlider ? latticeMismatchSlider.closest('.control-group') : null;
    const mismatchRelevant = STATE.growthMode === 'auto' || STATE.growthMode === 'SK';
    if (latticeMismatchSlider) latticeMismatchSlider.disabled = !mismatchRelevant;
    if (latticeGroup) latticeGroup.classList.toggle('control-disabled', !mismatchRelevant);

    const fieldGroup = document.getElementById('opFieldSlider')?.closest('.ctrl-row');
    if (fieldGroup) fieldGroup.classList.toggle('control-disabled', !STATE.drawMagLines);

    const electronGroup = document.getElementById('opElecSlider')?.closest('.ctrl-row');
    if (electronGroup) electronGroup.classList.toggle('control-disabled', !STATE.drawElectrons);

    [1, 2, 3].forEach(n => {
        const card = document.getElementById('gun-card-' + n);
        if (card) card.classList.toggle('control-disabled', !STATE.sources[n - 1].active);
    });
}

function applyPreset(presetName) {
    if (!presetName) return;

    const presets = {
        'high-rate': {
            pressure: 6,
            temperature: 340,
            mag: 0.05,
            gasComp: 0,
            sources: [
                { active: true, material: 'Cu', powerType: 'DC', power: 480 },
                { active: false, material: 'Al', powerType: 'RF', power: 200 },
                { active: false, material: 'Zn', powerType: 'RF', power: 200 }
            ]
        },
        'uniform': {
            pressure: 12,
            temperature: 320,
            mag: 0.03,
            gasComp: 0,
            sources: [
                { active: true, material: 'Cu', powerType: 'DC', power: 260 },
                { active: true, material: 'Al', powerType: 'RF', power: 220 },
                { active: false, material: 'Zn', powerType: 'RF', power: 200 }
            ]
        },
        'reactive': {
            pressure: 18,
            temperature: 300,
            mag: 0.04,
            gasComp: 20,
            sources: [
                { active: true, material: 'Al', powerType: 'RF', power: 240 },
                { active: false, material: 'Al', powerType: 'RF', power: 200 },
                { active: false, material: 'Zn', powerType: 'RF', power: 200 }
            ]
        },
        'co-sputter': {
            pressure: 10,
            temperature: 330,
            mag: 0.04,
            gasComp: 0,
            sources: [
                { active: true, material: 'Cu', powerType: 'DC', power: 260 },
                { active: true, material: 'Al', powerType: 'RF', power: 180 },
                { active: true, material: 'Zn', powerType: 'RF', power: 150 }
            ]
        }
    };

    const preset = presets[presetName];
    if (!preset) return;

    document.getElementById('pressureSlider').value = preset.pressure;
    document.getElementById('pressureSlider').dispatchEvent(new Event('input'));
    document.getElementById('tempSlider').value = preset.temperature;
    document.getElementById('tempSlider').dispatchEvent(new Event('input'));
    document.getElementById('magSlider').value = preset.mag;
    document.getElementById('magSlider').dispatchEvent(new Event('input'));
    document.getElementById('gasCompSlider').value = preset.gasComp;
    document.getElementById('gasCompSlider').dispatchEvent(new Event('input'));

    preset.sources.forEach((src, idx) => {
        const n = idx + 1;
        const active = document.getElementById(`src${n}Active`);
        const material = document.getElementById(`src${n}MatSelect`);
        const powerType = document.getElementById(`src${n}PowerType`);
        const power = document.getElementById(`src${n}PowerSlider`);

        if (material) {
            material.value = src.material;
            material.dispatchEvent(new Event('change'));
        }
        if (powerType) {
            powerType.value = src.powerType;
            powerType.dispatchEvent(new Event('change'));
        }
        if (active) {
            active.checked = src.active;
            active.dispatchEvent(new Event('change'));
        }
        if (power) {
            power.value = src.power;
            power.dispatchEvent(new Event('input'));
        }
    });

    updateRecipeSummary();
    updateControlRelevance();
    updateStartGuidance();
}

let lastAdvisorRecommendation = null;

function getAdvisorMaterialSelect() {
    return document.getElementById('aiMaterial');
}

function syncAdvisorDefaultsFromState() {
    const materialSelect = getAdvisorMaterialSelect();
    if (materialSelect) {
        materialSelect.value = STATE.sources[0]?.material || STATE.material || 'Cu';
    }
}

function getAdvisorInputs() {
    const material = document.getElementById('aiMaterial')?.value || STATE.sources[0]?.material || STATE.material || 'Cu';
    return { material };
}

function estimateRecipeMeanFreePathMeters(recipe) {
    const kB = 1.38e-23;
    const temperature = recipe.temperature || 300;
    const oxygenPercent = recipe.oxygenPercent || 0;
    const dMix = (3.5e-10 * (1 - oxygenPercent / 100)) + (3.0e-10 * (oxygenPercent / 100));
    const pressurePa = Math.max(0.1, recipe.pressure) * 0.133322;
    return (kB * temperature) / (Math.sqrt(2) * Math.PI * Math.pow(dMix, 2) * pressurePa);
}

function estimateRecipeDischarge(recipe) {
    const matProps = MATERIALS[recipe.material] || MATERIALS.Cu;
    const typeMods = getPowerTypeModifiers(recipe.powerType || 'DC');
    const pressureShift = constrain((12 - recipe.pressure) * 4.5, -60, 55);
    const powerShift = Math.sqrt(Math.max(recipe.power, 0)) * 9;
    const oxygenShift = (recipe.oxygenPercent / 100) * 55;
    const magneticRelief = constrain((recipe.magField - 0.03) / 0.09, -0.4, 1.0) * 26;
    const materialShift = constrain((matProps.Eb - 3.5) * 16, -24, 52);
    const baseVoltage = recipe.powerType === 'RF' ? 300 : 360;
    const voltage = constrain(baseVoltage + pressureShift + powerShift + oxygenShift + materialShift - magneticRelief, 220, 720);
    const current = recipe.power > 0 ? (recipe.power / voltage) : 0;
    const ionCurrent = current * 0.62 * typeMods.ionFlux;
    const ionEnergy = voltage * typeMods.ionEnergy * constrain(0.9 + (recipe.magField / 0.12) * 0.06, 0.88, 1.02);
    return { voltage, current, ionCurrent, ionEnergy };
}

function estimateRecipeIonAngle(recipe) {
    const pressureScatter = constrain(recipe.pressure / 24, 0, 1.1);
    const magneticTilt = constrain((recipe.magField - 0.03) / 0.05, -0.3, 0.8);
    const rfTilt = recipe.powerType === 'RF' ? 0.06 : 0.03;
    const distanceTilt = constrain((recipe.distanceCM - 8) / 12, 0, 1) * 0.08;
    const theta = 0.04 + pressureScatter * 0.08 + magneticTilt * 0.04 + rfTilt + distanceTilt;
    return constrain(theta, 0.02, radians(24));
}

function estimateRecipeYield(recipe) {
    const discharge = estimateRecipeDischarge(recipe);
    const matProps = MATERIALS[recipe.material] || MATERIALS.Cu;
    const typeMods = getPowerTypeModifiers(recipe.powerType || 'DC');
    const thetaRad = estimateRecipeIonAngle(recipe);
    const cleanYield = calculateYamamuraYield(discharge.ionEnergy, matProps, thetaRad) * typeMods.ionFlux;
    const poisoningPenalty = 1.0 - (recipe.oxygenPercent / 100) * 0.52;
    return Math.max(0, cleanYield * poisoningPenalty);
}

function estimateRecipeMetrics(recipe) {
    const lambda = estimateRecipeMeanFreePathMeters(recipe);
    const distanceMeters = Math.max(0.02, recipe.distanceCM / 100);
    const scatteringRatio = calculateScatteringRatio(distanceMeters, lambda);
    const transportFactor = constrain(Math.exp(-distanceMeters / Math.max(lambda, 1e-5)), 0.08, 1.0);
    const discharge = estimateRecipeDischarge(recipe);
    const yieldValue = estimateRecipeYield(recipe);
    const typeMods = getPowerTypeModifiers(recipe.powerType || 'DC');
    const energyForSticking = discharge.ionEnergy * 0.015;
    const thermalTerm = constrain(1.0 - (recipe.temperature - 300) / 900, 0.55, 1.02);
    const energyTerm = constrain(0.72 + Math.sqrt(Math.max(energyForSticking, 0.1)) * 0.07, 0.72, 1.05);
    const sticking = constrain(0.82 * thermalTerm * energyTerm * typeMods.sticking * (1.0 - (recipe.oxygenPercent / 100) * 0.08), 0.35, 0.96);
    const coverageRatio = constrain(recipe.targetDiaInches / Math.max(0.1, recipe.subDiaInches), 0.45, 1.4);
    const ratioSweet = Math.exp(-Math.pow((scatteringRatio - 1.25) / 0.95, 2));
    const distanceSweet = Math.exp(-Math.pow((recipe.distanceCM - 8.5) / 3.0, 2));
    const pressureSweet = Math.exp(-Math.pow((recipe.pressure - 1.5) / 1.3, 2));
    const magAssist = Math.exp(-Math.pow((recipe.magField - 0.035) / 0.018, 2));
    let uniformityPercent =
        46 +
        ratioSweet * 18 +
        distanceSweet * 12 +
        pressureSweet * 8 +
        magAssist * 4 +
        Math.max(0, coverageRatio - 0.72) * 32 -
        Math.max(0, scatteringRatio - 2.3) * 14 -
        Math.max(0, 0.95 - coverageRatio) * 24;
    uniformityPercent = constrain(uniformityPercent, 28, 98);

    const pressurePenalty = constrain(1.05 - recipe.pressure / 42, 0.35, 1.05);
    const magneticBoost = constrain(0.85 + (recipe.magField / 0.12) * 0.25, 0.75, 1.15);
    const typeBoost = recipe.powerType === 'RF' ? 1.06 : 1.0;
    const ionSpawnRatePerFrame = constrain(discharge.ionCurrent * 0.34 * pressurePenalty * magneticBoost * typeBoost, 0.06, 1.8);
    const ionRatePerSecond = ionSpawnRatePerFrame * 60;
    const depositedAtomsPerSecond = Math.max(
        0.25,
        ionRatePerSecond * Math.max(0.12, yieldValue) * transportFactor * sticking * 0.82
    );
    const nmPerDepositedAtom = 0.00225;
    const thicknessAfter60sNm = depositedAtomsPerSecond * 60 * nmPerDepositedAtom;
    const thicknessNmPerMin = thicknessAfter60sNm;
    const rateAtomsPerSecond = depositedAtomsPerSecond;
    const uniformityCode = classifyUniformity(uniformityPercent);
    const transportCode = classifyTransport(scatteringRatio);
    const statusText = generateProcessStatus(scatteringRatio, uniformityPercent);

    return {
        lambda,
        scatteringRatio,
        transportFactor,
        discharge,
        yieldValue,
        sticking,
        uniformityPercent,
        uniformityCode,
        transportCode,
        statusText,
        rateAtomsPerSecond,
        thicknessNmPerMin,
        thicknessAfter60sNm
    };
}

function recommendGrowthModeForRecipe(recipe, metrics) {
    const mismatch = Number.isFinite(STATE.latticeMismatch) ? STATE.latticeMismatch : 0.04;
    const temperatureNorm = constrain((recipe.temperature - 250) / 180, 0, 1);
    const energyNorm = constrain(metrics.discharge.ionEnergy / 500, 0, 1.2);
    const mobilityIndex = temperatureNorm * 0.55 + energyNorm * 0.25 + constrain(recipe.pressure / 12, 0, 0.35) * 0.2;
    if (mismatch > 0.07) return { code: 'SK', label: 'Stranski-Krastanov', reason: 'higher mismatch favors an initial wetting layer followed by islands' };
    if (mobilityIndex > 0.6) return { code: 'FM', label: 'Frank-van der Merwe', reason: 'surface mobility is high enough to favor layer-by-layer growth' };
    return { code: 'VW', label: 'Volmer-Weber', reason: 'lower adatom mobility favors island-like nucleation' };
}

function getRateTrendLabel(rateAtomsPerSecond) {
    if (rateAtomsPerSecond >= 8) return 'High';
    if (rateAtomsPerSecond >= 3) return 'Moderate';
    return 'Low';
}

function scoreRecipe(recipe, metrics, objective) {
    const coverageRatio = recipe.targetDiaInches / Math.max(0.1, recipe.subDiaInches);
    const uniformityScore = metrics.uniformityPercent;
    const rateScore = Math.min(100, metrics.rateAtomsPerSecond * 2.1);
    const scatteringPenalty = Math.max(0, metrics.scatteringRatio - 1.3) * 18;
    const geometryBonus = Math.max(0, Math.min(1.15, coverageRatio) - 0.8) * 18;

    if (objective === 'uniformity') {
        return uniformityScore + geometryBonus - Math.max(0, metrics.scatteringRatio - 2.0) * 16 + Math.min(18, rateScore * 0.15);
    }
    if (objective === 'rate') {
        return rateScore + Math.min(22, uniformityScore * 0.2) - scatteringPenalty * 0.35;
    }
    if (objective === 'low-scattering') {
        return 110 - metrics.scatteringRatio * 28 + Math.min(14, uniformityScore * 0.12) + Math.min(12, rateScore * 0.08);
    }
    return uniformityScore * 0.5 + rateScore * 0.28 + geometryBonus + (100 - scatteringPenalty) * 0.22;
}

function recommendRecipe(objective, material) {
    const modeOptions = ['DC', 'RF'];
    const pressureOptions = [0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0, 5.0];
    const powerOptions = [160, 200, 240, 280, 320, 380];
    const magOptions = [0.02, 0.03, 0.04, 0.05];
    const distanceOptions = [6, 8, 10, 12];
    const targetOptions = [3, 4, 5];
    const substrateOptions = [Math.max(2, Math.min(6, STATE.subDiaInches || 4))];

    let best = null;
    for (const powerType of modeOptions) {
        for (const pressure of pressureOptions) {
            for (const power of powerOptions) {
                for (const magField of magOptions) {
                    for (const distanceCM of distanceOptions) {
                        for (const targetDiaInches of targetOptions) {
                            for (const subDiaInches of substrateOptions) {
                                const recipe = {
                                    material,
                                    powerType,
                                    power,
                                    pressure,
                                    magField,
                                    distanceCM,
                                    targetDiaInches,
                                    subDiaInches,
                                    oxygenPercent: objective === 'balanced' ? 0 : 0,
                                    argonPercent: 100,
                                    temperature: 300
                                };
                                const metrics = estimateRecipeMetrics(recipe);
                                const score = scoreRecipe(recipe, metrics, objective);
                                if (!best || score > best.score) {
                                    best = { recipe, metrics, score };
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (best) {
        best.objective = objective;
        best.growthMode = recommendGrowthModeForRecipe(best.recipe, best.metrics);
    }
    return best;
}

function assessRecipeStatus(metrics, recipe) {
    const issues = [];
    if (recipe.power < 120) issues.push('power is too low for a meaningful teaching run');
    if (metrics.scatteringRatio >= 3.0) issues.push('gas scattering is too strong');
    else if (metrics.scatteringRatio >= 2.0) issues.push('gas scattering is higher than ideal');
    if (metrics.uniformityPercent < 70) issues.push('predicted film uniformity is poor');
    if (recipe.targetDiaInches < recipe.subDiaInches * 0.9) issues.push('target coverage is smaller than the substrate');
    if (recipe.pressure < 0.5) issues.push('Pressure is below the typical magnetron discharge stability limit. Real magnetron systems generally require at least 0.5 mTorr to sustain a stable glow discharge.');
    if (recipe.oxygenPercent > 25) issues.push('reactive gas fraction is likely too aggressive');

    let statusCode = 'READY';
    if (issues.length >= 2 || metrics.uniformityPercent < 60 || recipe.power < 100 || metrics.scatteringRatio >= 3.2) statusCode = 'NOT_RECOMMENDED';
    else if (issues.length >= 1 || metrics.uniformityPercent < 85 || metrics.scatteringRatio >= 2.0) statusCode = 'MARGINAL';

    let keyIssue = issues[0] || 'recipe is physically usable in the reduced-order model';
    return { statusCode, issues, keyIssue };
}

function getStatusLabel(statusCode) {
    if (statusCode === 'READY') return 'Ready to run';
    if (statusCode === 'MARGINAL') return 'Usable with caution';
    return 'Not recommended';
}

function buildAdvisorExplanation(assessment, currentRecipe, currentMetrics, suggestedFix) {
    const growth = assessment.growthMode || recommendGrowthModeForRecipe(currentRecipe, currentMetrics);
    if (assessment.statusCode === 'READY') {
        return `These settings are usable for a reduced-order sputtering run. Transport is ${getTransportDisplayLabel(currentMetrics.transportCode).toLowerCase()}, predicted uniformity is about ${currentMetrics.uniformityPercent.toFixed(0)}%, and the suggested growth mode is ${growth.label} because ${growth.reason}. You can start the process directly from here.`;
    }
    if (assessment.statusCode === 'MARGINAL') {
        return `The current recipe can run, but it is not in a particularly comfortable process window. The main issue is that ${assessment.keyIssue}. A better nearby setting would shift toward ${suggestedFix.recipe.pressure.toFixed(1)} mTorr, ${suggestedFix.recipe.power} W, ${suggestedFix.recipe.distanceCM.toFixed(0)} cm, and ${suggestedFix.growthMode.label} growth so the film trend is easier to interpret in class.`;
    }
    return `The current settings are unlikely to give a useful thin-film teaching result. The strongest limitation is that ${assessment.keyIssue}. The suggested fix moves the recipe into a more stable reduced-order sputtering window with ${getTransportDisplayLabel(suggestedFix.metrics.transportCode).toLowerCase()} transport, about ${suggestedFix.metrics.uniformityPercent.toFixed(0)}% predicted uniformity, and ${suggestedFix.growthMode.label} growth behavior.`;
}

function getCurrentRecipeForAdvisor() {
    const activeSource = STATE.sources.find(src => src.active && src.power >= 80) || STATE.sources[0];
    const material = document.getElementById('aiMaterial')?.value || activeSource?.material || STATE.material || 'Cu';
    return {
        material,
        powerType: activeSource?.powerType || 'DC',
        power: activeSource?.power || 0,
        pressure: STATE.pressure,
        magField: STATE.magField,
        distanceCM: STATE.distanceCM,
        targetDiaInches: STATE.targetDiaInches,
        subDiaInches: STATE.subDiaInches,
        oxygenPercent: STATE.oxygenPercent,
        argonPercent: STATE.argonPercent,
        temperature: STATE.temperature
    };
}

function evaluateCurrentRecipe(material) {
    const currentRecipe = getCurrentRecipeForAdvisor();
    currentRecipe.material = material || currentRecipe.material;
    const currentMetrics = estimateRecipeMetrics(currentRecipe);
    const growthMode = recommendGrowthModeForRecipe(currentRecipe, currentMetrics);
    const assessment = assessRecipeStatus(currentMetrics, currentRecipe);
    assessment.growthMode = growthMode;

    const objective = assessment.statusCode === 'READY'
        ? 'balanced'
        : (currentMetrics.uniformityPercent < 80 ? 'uniformity' : currentMetrics.scatteringRatio > 2 ? 'low-scattering' : 'balanced');
    const suggestedFix = recommendRecipe(objective, currentRecipe.material);
    const explanation = buildAdvisorExplanation(assessment, currentRecipe, currentMetrics, suggestedFix);
    return { currentRecipe, currentMetrics, assessment, suggestedFix, explanation };
}

function renderAdvisorAssessment(result) {
    const panel = document.getElementById('aiAdvisorResult');
    if (!panel || !result) return;
    panel.classList.remove('hidden');

    const { currentRecipe, currentMetrics, assessment, suggestedFix } = result;
    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    setText('aiAdvisorStatus', getStatusLabel(assessment.statusCode));
    setText('aiRecStatus', getStatusLabel(assessment.statusCode));
    setText('aiRecPressure', `${currentRecipe.pressure.toFixed(1)} mTorr`);
    setText('aiRecPower', `${currentRecipe.power} W / ${currentRecipe.powerType}`);
    setText('aiRecMag', `${currentRecipe.magField.toFixed(2)} T`);
    setText('aiRecDistance', `${currentRecipe.distanceCM.toFixed(0)} cm`);
    setText('aiRecGeometry', `${currentRecipe.targetDiaInches.toFixed(1)} in / ${currentRecipe.subDiaInches.toFixed(1)} in`);
    setText('aiRecRegime', getTransportDisplayLabel(currentMetrics.transportCode));
    setText('aiRecUniformity', `${currentMetrics.uniformityPercent.toFixed(0)}% (${getUniformityDisplayLabel(currentMetrics.uniformityCode)})`);
    setText('aiRecRate', getRateTrendLabel(currentMetrics.rateAtomsPerSecond));
    setText('aiRecGrowthMode', assessment.growthMode.label);
    setText('aiRecIssue', assessment.keyIssue);
    setText('aiAdvisorExplanation', result.explanation);

    const startBtn = document.getElementById('btn-ai-start');
    const applyBtn = document.getElementById('btn-ai-apply');
    if (startBtn) {
        startBtn.textContent = assessment.statusCode === 'READY' ? 'Start Process' : 'Run Anyway';
    }
    if (applyBtn) {
        applyBtn.textContent = assessment.statusCode === 'READY' ? 'Apply Suggested Window' : 'Apply Suggested Fix';
    }
    const statusEl = document.getElementById('aiAdvisorStatus');
    if (statusEl) {
        statusEl.style.color = assessment.statusCode === 'READY'
            ? 'var(--accent-green)'
            : assessment.statusCode === 'MARGINAL'
                ? 'var(--accent-yellow)'
                : '#ff7a7a';
    }
}

function applyRecommendedRecipe(recipe, growthModeCode = 'auto') {
    if (!recipe) return;

    const setInputValue = (id, value, eventName = 'input') => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = value;
        el.dispatchEvent(new Event(eventName));
    };

    setInputValue('pressureSlider', recipe.pressure);
    setInputValue('tempSlider', recipe.temperature);
    setInputValue('magSlider', recipe.magField);
    setInputValue('argonSlider', recipe.argonPercent);
    setInputValue('gasCompSlider', recipe.oxygenPercent);
    setInputValue('distanceSlider', recipe.distanceCM);
    setInputValue('targetDiaSlider', recipe.targetDiaInches);
    setInputValue('subDiaSlider', recipe.subDiaInches);
    const growthModeSelect = document.getElementById('growthModeSelect');
    if (growthModeSelect) {
        growthModeSelect.value = growthModeCode || 'auto';
        growthModeSelect.dispatchEvent(new Event('change'));
    }

    [1, 2, 3].forEach((n) => {
        const active = document.getElementById(`src${n}Active`);
        const material = document.getElementById(`src${n}MatSelect`);
        const powerType = document.getElementById(`src${n}PowerType`);
        const power = document.getElementById(`src${n}PowerSlider`);
        const isPrimary = n === 1;

        if (material) {
            material.value = isPrimary ? recipe.material : (STATE.sources[n - 1]?.material || material.value);
            material.dispatchEvent(new Event('change'));
        }
        if (powerType) {
            powerType.value = isPrimary ? recipe.powerType : (STATE.sources[n - 1]?.powerType || powerType.value);
            powerType.dispatchEvent(new Event('change'));
        }
        if (active) {
            active.checked = isPrimary;
            active.dispatchEvent(new Event('change'));
        }
        if (power) {
            power.value = isPrimary ? recipe.power : (STATE.sources[n - 1]?.power || power.value);
            power.dispatchEvent(new Event('input'));
        }
    });
    STATE.advisorRunTargetMs = null;
    STATE.advisorTargetThicknessNm = null;
    STATE.advisorAutoPauseMessage = '';

    updateStaticYield();
    updateRecipeSummary();
    updateControlRelevance();
    updateStartGuidance();
}

function handleAdvisorCheck() {
    const { material } = getAdvisorInputs();
    const result = evaluateCurrentRecipe(material);
    lastAdvisorRecommendation = result;
    renderAdvisorAssessment(result);
}

let TARGET_Y = 400;
let SUBSTRATE_Y = 50;
let CANVAS_W = 800;
let CANVAS_H = 500;
let BIN_SIZE = 5;
let NUM_BINS = CANVAS_W / BIN_SIZE;
const WALL_W = 8;  // Visible chamber wall thickness (px)
const WALL_SOFT = 35; // Soft absorption zone inward from walls (px)
const CHAMBER_ML = 88; // Left visual margin â€” tighter chamber envelope
const CHAMBER_MR = 88;  // Right visual margin â€” mirror the left side for a more realistic chamber

// Material Dictionary (Binding Energies in eV and Display Colors)
const MATERIALS = {
    'Cu': { name: 'Copper', Eb: 3.49, U0: 3.49, color: [184, 115, 51], sputterTint: [212, 108, 72], mass: 63.5, Z: 29, yamQ: 0.115, angleShape: 1.55, Eth: 24 },
    'Al': { name: 'Aluminum', Eb: 3.39, U0: 3.39, color: [210, 210, 220], sputterTint: [220, 196, 92], mass: 27.0, Z: 13, yamQ: 0.150, angleShape: 1.48, Eth: 21 },
    'Ti': { name: 'Titanium', Eb: 4.89, U0: 4.89, color: [135, 134, 139], mass: 47.9, Z: 22, yamQ: 0.092, angleShape: 1.62, Eth: 28 },
    'Ta': { name: 'Tantalum', Eb: 8.10, U0: 8.10, color: [138, 141, 143], mass: 180.9, Z: 73, yamQ: 0.050, angleShape: 1.82, Eth: 36 },
    'Zn': { name: 'Zinc', Eb: 1.35, U0: 1.35, color: [173, 210, 180], sputterTint: [224, 138, 64], mass: 65.4, Z: 30, yamQ: 0.208, angleShape: 1.42, Eth: 14 },
    'Sn': { name: 'Tin', Eb: 3.12, U0: 3.12, color: [200, 200, 212], mass: 118.7, Z: 50, yamQ: 0.112, angleShape: 1.50, Eth: 20 },
    'W': { name: 'Tungsten', Eb: 8.83, U0: 8.83, color: [120, 120, 140], mass: 183.8, Z: 74, yamQ: 0.046, angleShape: 1.86, Eth: 38 },
    'Mo': { name: 'Molybdenum', Eb: 6.83, U0: 6.83, color: [100, 110, 130], mass: 95.9, Z: 42, yamQ: 0.074, angleShape: 1.72, Eth: 31 }
};

const PROJECTILE_AR = { symbol: 'Ar', mass: 39.95, Z: 18 };

// HTML Elements
let energyEl, pressureEl, magEl;
let yieldStatEl, depositedStatEl;

// Chart.js instances
let depChart;
let profileChart;
let timeSec = 0;
// â”€â”€ Process Timer â”€â”€
let _timerInterval = null;
let _timerMs = 0;        // total elapsed milliseconds
let _timerRunning = false;

// Setup called once by p5.js
function windowResized() {
    let newW = Math.min(windowWidth * 0.9, 1400);
    let newH = Math.min(windowHeight * 0.7, 800);
    const container = document.getElementById('canvas-container');
    if (container) {
        let rect = container.getBoundingClientRect();
        newW = rect.width;
        newH = rect.height;
    }

    // Enforce limits
    newW = Math.max(300, Math.min(newW, 1400));
    newH = Math.max(350, Math.min(newH, 800));

    resizeCanvas(newW, newH);
    CANVAS_W = width;
    CANVAS_H = height;

    NUM_BINS = Math.floor(CANVAS_W / BIN_SIZE);
    SUBSTRATE_Y = Math.max(42, CANVAS_H * 0.07);
    TARGET_Y = Math.min(CANVAS_H * 0.72, SUBSTRATE_Y + (STATE.distanceCM * 28));

    // Resize profile array gracefully
    let oldProfile = substrateProfile.slice();
    let oldVisualProfile = visualFilmProfile.slice();
    substrateProfile = new Array(NUM_BINS).fill(0);
    visualFilmProfile = new Array(NUM_BINS).fill(0);
    for (let i = 0; i < Math.min(oldProfile.length, NUM_BINS); i++) {
        substrateProfile[i] = oldProfile[i];
    }
    for (let i = 0; i < Math.min(oldVisualProfile.length, NUM_BINS); i++) {
        visualFilmProfile[i] = oldVisualProfile[i];
    }

    // Update profile chart labels
    if (profileChart) {
        let labels = [];
        for (let i = 0; i < NUM_BINS; i++) {
            labels.push((i * BIN_SIZE) - (CANVAS_W / 2));
        }
        profileChart.data.labels = labels;
        profileChart.update('none'); // silent update
    }
    redraw();
}

function setup() {
    try {
        const container = document.getElementById('canvas-container');
        const rect = container.getBoundingClientRect();
        CANVAS_W = rect.width || 800;
        CANVAS_H = rect.height || 500;
        NUM_BINS = Math.floor(CANVAS_W / BIN_SIZE);

        let canvas = createCanvas(CANVAS_W, CANVAS_H);
        syncDerivedPowerState();

        // Start fully idle â€” no simulation until user clicks Start Process
        STATE.isRunning = false;
        noLoop(); // p5: stop draw() from running continuously on load

        canvas.parent('canvas-container');

        // Dynamic targets
        SUBSTRATE_Y = Math.max(42, CANVAS_H * 0.07);
        TARGET_Y = Math.min(CANVAS_H * 0.72, SUBSTRATE_Y + (STATE.distanceCM * 28));

        // Initialize Substrate Profile
        for (let i = 0; i < NUM_BINS; i++) substrateProfile[i] = 0;
        for (let i = 0; i < NUM_BINS; i++) layerMap[i] = 0;
        nucleationSites = [];

        bindUIEvents();
        initIdleUI(); // set button states for idle start

        try {
            initChart();
        } catch (e) {
            console.error("ChartInit Error:", e);
        }
        refreshProcessDiagnosticsFromState();

        setInterval(() => {
            if (STATE.isRunning && !STATE.paused && STATE.mode === 'simulation') {
                try {
                    updateChart();
                } catch (e) {
                    console.error("ChartUpdate Error:", e);
                }
            }
        }, 1000);
    } catch (err) {
        let errDiv = document.createElement('div');
        errDiv.style = "position:fixed; top:10%; left:10%; width:80%; padding:20px; background:red; color:white; font-size:24px; z-index:9999;";
        errDiv.innerHTML = "<strong>CRITICAL SETUP ERROR:</strong><br>" + err.message + "<br>Stack: " + err.stack;
        document.body.appendChild(errDiv);
    }
}

function syncGasMixUI(source) {
    const oxygenSlider = document.getElementById('gasCompSlider');
    const argonSlider = document.getElementById('argonSlider');
    const oxygenVal = document.getElementById('gasCompVal');
    const argonVal = document.getElementById('argonVal');
    if (!oxygenSlider || !argonSlider) return;

    if (source === 'argon') {
        STATE.argonPercent = parseInt(argonSlider.value, 10);
        STATE.oxygenPercent = Math.max(0, 100 - STATE.argonPercent);
        oxygenSlider.value = STATE.oxygenPercent;
    } else {
        STATE.oxygenPercent = parseInt(oxygenSlider.value, 10);
        STATE.argonPercent = Math.max(50, 100 - STATE.oxygenPercent);
        argonSlider.value = STATE.argonPercent;
    }

    if (oxygenVal) oxygenVal.innerText = `${STATE.oxygenPercent} %`;
    if (argonVal) argonVal.innerText = `${STATE.argonPercent} %`;
    updateStaticYield();
    updateRecipeSummary();
}

function bindUIEvents() {


    document.getElementById('pressureSlider').addEventListener('input', (e) => {
        STATE.pressure = parseFloat(e.target.value);
        document.getElementById('pressureVal').innerText = STATE.pressure;
        refreshProcessDiagnosticsFromState();
        updateRecipeSummary();
    });

    document.getElementById('tempSlider').addEventListener('input', (e) => {
        STATE.temperature = parseInt(e.target.value);
        document.getElementById('tempVal').innerText = STATE.temperature;
    });

    document.getElementById('magSlider').addEventListener('input', (e) => {
        STATE.magField = parseFloat(e.target.value);
        document.getElementById('magVal').innerText = STATE.magField.toFixed(2);
    });

    document.getElementById('densitySlider').addEventListener('input', (e) => {
        STATE.particleDensity = parseFloat(e.target.value) / 100.0;
        document.getElementById('densityVal').innerText = e.target.value;
    });

    document.getElementById('argonSlider').addEventListener('input', () => {
        syncGasMixUI('argon');
    });

    document.getElementById('gasCompSlider').addEventListener('input', () => {
        syncGasMixUI('oxygen');
    });

    syncGasMixUI('oxygen');

    document.getElementById('materialSelect').addEventListener('change', (e) => {
        STATE.material = e.target.value;
        updateStaticYield();
    });

    document.getElementById('hqPlasmaCheck').addEventListener('change', (e) => {
        STATE.hqPlasma = e.target.checked;
        if (e.target.checked) e.target.parentElement.classList.add('checked');
        else e.target.parentElement.classList.remove('checked');
    });

    document.getElementById('drawMagLinesCheck').addEventListener('change', (e) => {
        STATE.drawMagLines = e.target.checked;
        if (e.target.checked) e.target.parentElement.classList.add('checked');
        else e.target.parentElement.classList.remove('checked');
        updateControlRelevance();
    });

    document.getElementById('drawElectronsCheck').addEventListener('change', (e) => {
        STATE.drawElectrons = e.target.checked;
        if (e.target.checked) e.target.parentElement.classList.add('checked');
        else e.target.parentElement.classList.remove('checked');
        updateControlRelevance();
    });

    document.getElementById('substrateRotCheck').addEventListener('change', (e) => {
        STATE.substrateRotEnabled = e.target.checked;
        if (e.target.checked) e.target.parentElement.classList.add('checked');
        else e.target.parentElement.classList.remove('checked');
    });

    // Also initialize their initial `.checked` class depending on literal checked prop
    ['hqPlasmaCheck', 'drawMagLinesCheck', 'drawElectronsCheck', 'substrateRotCheck', 'lowClutterCheck'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.checked && el.parentElement) el.parentElement.classList.add('checked');
    });

    // Make visualisation rows reliable single-click controls. The visible row
    // owns the click; the checkbox itself is display/state only.
    document.querySelectorAll('#vis-panel .toggle-row').forEach(row => {
        const input = row.querySelector('input[type="checkbox"]');
        if (!input) return;
        row.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            input.checked = !input.checked;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    // Clutter reduction and opacities
    document.getElementById('lowClutterCheck').addEventListener('change', (e) => {
        STATE.lowClutterMode = e.target.checked;
        if (e.target.checked) e.target.parentElement.classList.add('checked');
        else e.target.parentElement.classList.remove('checked');
    });

    document.getElementById('opFieldSlider').addEventListener('input', (e) => {
        STATE.opField = parseInt(e.target.value) / 100.0;
        document.getElementById('opFieldVal').innerText = e.target.value + "%";
    });
    document.getElementById('opElecSlider').addEventListener('input', (e) => {
        STATE.opElec = parseInt(e.target.value) / 100.0;
        document.getElementById('opElecVal').innerText = e.target.value + "%";
    });
    document.getElementById('opGlowSlider').addEventListener('input', (e) => {
        STATE.opGlow = parseInt(e.target.value) / 100.0;
        document.getElementById('opGlowVal').innerText = e.target.value + "%";
    });
    document.getElementById('opPartSlider').addEventListener('input', (e) => {
        STATE.opPart = parseInt(e.target.value) / 100.0;
        document.getElementById('opPartVal').innerText = e.target.value + "%";
    });

    // New Geometries and Speed
    document.getElementById('speedSlider').addEventListener('input', (e) => {
        STATE.simSpeed = parseFloat(e.target.value);
        document.getElementById('speedVal').innerText = STATE.simSpeed.toFixed(1);
    });

    document.getElementById('distanceSlider').addEventListener('input', (e) => {
        STATE.distanceCM = parseFloat(e.target.value);
        document.getElementById('distanceVal').innerText = STATE.distanceCM;
    });

    document.getElementById('targetDiaSlider').addEventListener('input', (e) => {
        STATE.targetDiaInches = parseFloat(e.target.value);
        document.getElementById('targetDiaVal').innerText = STATE.targetDiaInches;
    });

    document.getElementById('subDiaSlider').addEventListener('input', (e) => {
        STATE.subDiaInches = parseFloat(e.target.value);
        document.getElementById('subDiaVal').innerText = STATE.subDiaInches;
    });


    // View Mode & Source Count
    const viewModeSelect = document.getElementById('viewModeSelect');
    if (viewModeSelect) {
        viewModeSelect.addEventListener('change', (e) => {
            STATE.viewMode3D = (e.target.value === '3D');
        });
    }

    const numSourcesSelect = document.getElementById('numSourcesSelect');
    if (numSourcesSelect) {
        numSourcesSelect.addEventListener('change', (e) => {
            STATE.numSources = parseInt(e.target.value);
        });
    }

    // Growth Mode
    const growthModeSelect = document.getElementById('growthModeSelect');
    if (growthModeSelect) {
        growthModeSelect.addEventListener('change', (e) => {
            STATE.growthMode = e.target.value;
            // Reset island sites when mode changes
            nucleationSites = [];
            STATE.skPhase = 'layer';
            updateControlRelevance();
        });
    }

    const latticeMismatchSlider = document.getElementById('latticeMismatchSlider');
    if (latticeMismatchSlider) {
        latticeMismatchSlider.addEventListener('input', (e) => {
            STATE.latticeMismatch = parseFloat(e.target.value) / 100;
            document.getElementById('latticeMismatchVal').innerText = e.target.value + '%';
            STATE.criticalThickness = Math.max(1.0, 8.0 - STATE.latticeMismatch * 120);
        });
    }

    // Source Configuration bindings (co-sputtering)
    [1, 2, 3].forEach(n => {
        const matSel = document.getElementById('src' + n + 'MatSelect');
        if (matSel) {
            matSel.addEventListener('change', (e) => {
                STATE.sources[n - 1].material = e.target.value;
                if (n === 1) STATE.material = e.target.value; // keep alias in sync
                if (n === 1) {
                    const advisorMaterial = getAdvisorMaterialSelect();
                    if (advisorMaterial) advisorMaterial.value = e.target.value;
                }
                updateStaticYield();
            });
        }
        const activeCb = document.getElementById('src' + n + 'Active');
        if (activeCb) {
            activeCb.addEventListener('change', (e) => {
                STATE.sources[n - 1].active = e.target.checked;
                let ps = document.getElementById('src' + n + 'PowerSlider');
                if (ps) ps.disabled = !e.target.checked;
                updateStaticYield();
            });
        }
        const powerSlider = document.getElementById('src' + n + 'PowerSlider');
        if (powerSlider) {
            powerSlider.addEventListener('input', (e) => {
                STATE.sources[n - 1].power = parseInt(e.target.value);
                let pv = document.getElementById('src' + n + 'PowerVal');
                if (pv) pv.innerText = e.target.value + 'W';
                updateStaticYield();
            });
        }
        const powerType = document.getElementById('src' + n + 'PowerType');
        if (powerType) {
            powerType.addEventListener('change', (e) => {
                STATE.sources[n - 1].powerType = e.target.value;
                updateStaticYield();
            });
        }
    });


    // Accordion Logic
    document.querySelectorAll('.accordion-header').forEach(header => {
        header.addEventListener('click', () => {
            const accordion = header.parentElement;
            // Toggle active class
            accordion.classList.toggle('active');
        });
    });



    function resetChartData() {
        if (depChart) {
            depChart.data.labels = [STATE.chartMode === 'power' ? Math.round(getTotalActivePower()) : 0];
            depChart.data.datasets.forEach(ds => ds.data = [0]);
            depChart.update();
        }
    }

    // Buttons
    document.getElementById('btn-intro').addEventListener('click', startIntro);

    // Start / Resume button (primary action)
    let startBtn = document.getElementById('btn-start');
    if (startBtn) startBtn.addEventListener('click', toggleSputtering);

    document.getElementById('btn-reset').addEventListener('click', resetSim);
    document.getElementById('btn-reset-target').addEventListener('click', () => {
        STATE.erosionLevel = 0;
    });
    document.getElementById('btn-reset-defaults').addEventListener('click', resetLabDefaults);
    document.getElementById('btn-export').addEventListener('click', exportCSV);
    document.getElementById('btn-tut-next').addEventListener('click', nextTutorialStep);
    const presetBtn = document.getElementById('btn-apply-preset');
    if (presetBtn) {
        presetBtn.addEventListener('click', () => applyPreset(document.getElementById('presetSelect')?.value));
    }
    const aiCheckBtn = document.getElementById('btn-ai-check');
    if (aiCheckBtn) {
        aiCheckBtn.addEventListener('click', handleAdvisorCheck);
    }
    const aiApplyBtn = document.getElementById('btn-ai-apply');
    if (aiApplyBtn) {
        aiApplyBtn.addEventListener('click', () => {
            if (lastAdvisorRecommendation) {
                applyRecommendedRecipe(
                    lastAdvisorRecommendation.suggestedFix?.recipe,
                    lastAdvisorRecommendation.suggestedFix?.growthMode?.code || 'auto'
                );
            }
        });
    }
    const aiStartBtn = document.getElementById('btn-ai-start');
    if (aiStartBtn) {
        aiStartBtn.addEventListener('click', () => {
            if (!STATE.isRunning) toggleSputtering();
        });
    }

    const btnChartTime = document.getElementById('btn-chart-time');
    if (btnChartTime) {
        btnChartTime.addEventListener('click', () => setChartMode('time'));
    }

    const btnChartPower = document.getElementById('btn-chart-power');
    if (btnChartPower) {
        btnChartPower.addEventListener('click', () => setChartMode('power'));
    }

    // Thickness target controls
    const btnSetTarget = document.getElementById('btn-set-thickness-target');
    if (btnSetTarget) {
        btnSetTarget.addEventListener('click', () => {
            const input = document.getElementById('targetThicknessInput');
            const val = parseFloat(input.value);
            if (!Number.isFinite(val) || val <= 0) {
                input.style.borderColor = 'var(--accent-red, #ff4466)';
                setTimeout(() => input.style.borderColor = '', 1200);
                return;
            }
            input.style.borderColor = '';
            STATE.thicknessTargetNm = val;
            STATE.thicknessTargetActive = true;
            STATE.thicknessTargetAchieved = false;
            const achieved = document.getElementById('thickness-target-achieved');
            if (achieved) achieved.style.display = 'none';
            updateThicknessTargetUI();
        });
    }

    const btnClearTarget = document.getElementById('btn-clear-thickness-target');
    if (btnClearTarget) {
        btnClearTarget.addEventListener('click', () => {
            STATE.thicknessTargetNm = null;
            STATE.thicknessTargetActive = false;
            STATE.thicknessTargetAchieved = false;
            const input = document.getElementById('targetThicknessInput');
            if (input) input.value = '';
            const status = document.getElementById('thickness-target-status');
            if (status) status.style.display = 'none';
            const achieved = document.getElementById('thickness-target-achieved');
            if (achieved) achieved.style.display = 'none';
        });
    }

    const btnExportFig3 = document.getElementById('btn-export-fig3');
    if (btnExportFig3) {
        btnExportFig3.addEventListener('click', exportFigure3Data);
    }

    // Initial Yield Calculation
    updateStaticYield();
    setChartMode(STATE.chartMode);
    updateControlRelevance();
    updateStartGuidance();
    syncAdvisorDefaultsFromState();
}

// Called at end of setup() to initialise button/HUD state
function initIdleUI() {
    // Uncheck gun 1 checkbox in the DOM to match STATE
    let cb1 = document.getElementById('src1Active');
    if (cb1) { cb1.checked = false; cb1.dispatchEvent(new Event('change')); }
    _updateStartBtnUI();
    updateRecipeSummary();
    updateControlRelevance();
    updateStartGuidance();
    syncAdvisorDefaultsFromState();
    // Draw static chamber so canvas is not a black void
    redraw();
}

function initChart() {
    const ctx = document.getElementById('depChart').getContext('2d');
    depChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [0],
            datasets: [
                {
                    label: 'Rate (atoms/s)',
                    data: [0],
                    borderColor: '#00bcd4',
                    backgroundColor: 'rgba(0, 188, 212, 0.2)',
                    tension: 0.4,
                    fill: true,
                    yAxisID: 'y'
                },
                {
                    label: 'Physical Yield',
                    data: [0],
                    borderColor: '#ffeb3b',
                    borderDash: [5, 5],
                    tension: 0.4,
                    fill: false,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            scales: {
                x: { title: { display: true, text: 'Time (s)', color: '#aaa' } },
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    title: { display: true, text: 'Rate', color: '#00bcd4' },
                    min: 0
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: { display: true, text: 'Yield (Y)', color: '#ffeb3b' },
                    min: 0,
                    grid: { drawOnChartArea: false } // Avoid double grid lines
                }
            },
            plugins: {
                legend: { display: true, labels: { color: '#fff' } }
            },
            maintainAspectRatio: false,
            animation: false
        }
    });

    initProfileChart();
}

function initProfileChart() {
    const ctx = document.getElementById('profileChart').getContext('2d');

    // Create an X-axis representing physical chamber position (Left to Right Edge)
    let labels = [];
    for (let i = 0; i < NUM_BINS; i++) {
        labels.push((i * BIN_SIZE) - (CANVAS_W / 2)); // 0 in center
    }

    profileChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Film Thickness',
                data: Array(NUM_BINS).fill(0),
                borderColor: '#e91e63',
                backgroundColor: 'rgba(233, 30, 99, 0.2)',
                tension: 0.4,
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 0,
                borderWidth: 4,
                cubicInterpolationMode: 'monotone'
            }]
        },
        options: {
            scales: {
                x: {
                    title: { display: true, text: 'Position from Center (px)', color: '#aaa' },
                    ticks: { maxTicksLimit: 7 }
                },
                y: {
                    title: { display: true, text: 'Thickness (nm)', color: '#aaa' },
                    min: 0
                }
            },
            plugins: {
                legend: { display: false }
            },
            maintainAspectRatio: false,
            animation: false
        }
    });
}


// Moving average helper
function movingAverage(arr, windowSize) {
    if (windowSize <= 1) return arr;
    let res = [];
    for (let i = 0; i < arr.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - Math.floor(windowSize / 2)); j <= Math.min(arr.length - 1, i + Math.floor(windowSize / 2)); j++) {
            sum += arr[j];
            count++;
        }
        res.push(sum / count);
    }
    return res;
}

function getFilmBarHeightPx() {
    const centerProxy = STATE.lastUniformityMetrics && Number.isFinite(STATE.lastUniformityMetrics.centerThicknessNm)
        ? STATE.lastUniformityMetrics.centerThicknessNm
        : 0;
    const avgProxy = Number.isFinite(STATE.avgThickness) ? STATE.avgThickness : 0;
    const thicknessProxy = Math.max(0, centerProxy, avgProxy);
    if (thicknessProxy <= 0) return 0;
    // Keep early-stage films subtle, but still readable enough for classroom use.
    if (thicknessProxy < 0.5) {
        return constrain(0.75 + thicknessProxy * 3.10, 0.75, 2.30);
    }
    if (thicknessProxy < 2.5) {
        return constrain(2.30 + (thicknessProxy - 0.5) * 1.08, 2.30, 4.45);
    }
    if (thicknessProxy < 8) {
        return constrain(4.45 + Math.sqrt(thicknessProxy - 2.5) * 1.08, 4.45, 7.55);
    }
    return constrain(7.55 + Math.sqrt(thicknessProxy - 8) * 0.96, 7.55, 12.5);
}

function getVisibleFilmThicknessNm() {
    const centerProxy = STATE.lastUniformityMetrics && Number.isFinite(STATE.lastUniformityMetrics.centerThicknessNm)
        ? STATE.lastUniformityMetrics.centerThicknessNm
        : 0;
    const avgProxy = Number.isFinite(STATE.avgThickness) ? STATE.avgThickness : 0;
    return Math.max(0, centerProxy, avgProxy);
}

function drawGrowingFilmBar() {
    const filmH = getFilmBarHeightPx();
    const gaugeH = 28;
    const gaugeX = CANVAS_W - CHAMBER_MR - WALL_W - 28;
    const baseY = SUBSTRATE_Y + 64;
    const thicknessNm = getVisibleFilmThicknessNm();

    push();
    rectMode(CORNER);
    textAlign(RIGHT, CENTER);
    strokeWeight(1);

    drawingContext.shadowBlur = 10;
    drawingContext.shadowColor = 'rgba(0,0,0,0.35)';
    noStroke();
    fill(10, 14, 22, 150);
    rect(gaugeX - 96, baseY - gaugeH - 16, 102, gaugeH + 32, 6);
    drawingContext.shadowBlur = 0;

    stroke(180, 188, 202, 70);
    line(gaugeX, baseY - gaugeH, gaugeX, baseY);
    for (let i = 0; i <= 4; i++) {
        let ty = baseY - (gaugeH * i / 4);
        line(gaugeX - 4, ty, gaugeX + 4, ty);
    }

    if (filmH > 0.2) {
        drawingContext.shadowBlur = 8;
        drawingContext.shadowColor = 'rgba(255,160,70,0.28)';
        noStroke();
        fill(255, 168, 74, 155);
        rect(gaugeX - 2.5, baseY - filmH, 5, filmH, 2);
        fill(255, 214, 148, 110);
        rect(gaugeX - 1.5, baseY - filmH, 3, Math.max(1.5, filmH * 0.65), 2);
        drawingContext.shadowBlur = 0;
    }

    noStroke();
    fill(255, 208, 138, 185);
    textSize(9);
    text(`${thicknessNm.toFixed(2)} nm`, gaugeX - 10, baseY - filmH);
    fill(175, 188, 204, 135);
    text('film thickness', gaugeX - 10, baseY - gaugeH - 6);
    pop();
}

function drawSubstrateHolder(subWidthPx) {
    const holderH = 14;
    push();
    rectMode(CENTER);
    noStroke();

    drawingContext.shadowBlur = 14;
    drawingContext.shadowColor = 'rgba(40,190,255,0.20)';
    fill(18, 58, 78, 246);
    rect(0, 0, subWidthPx, holderH, 3);
    drawingContext.shadowBlur = 0;

    stroke(72, 216, 255, 205);
    strokeWeight(1.1);
    fill(22, 94, 126, 188);
    rect(0, 0, subWidthPx - 2, holderH - 2, 3);

    noStroke();
    fill(130, 235, 255, 38);
    rect(0, -holderH * 0.16, subWidthPx * 0.94, holderH * 0.28, 2);

    if (STATE.substrateRotEnabled) {
        const tickOffset = ((STATE.substrateRot || 0) * 18) % 28;
        const clipInset = 8;
        drawingContext.save();
        drawingContext.beginPath();
        drawingContext.rect(-subWidthPx / 2 + clipInset, -holderH / 2 + 1.5, subWidthPx - clipInset * 2, holderH - 3);
        drawingContext.clip();
        stroke(144, 242, 255, 105);
        strokeWeight(0.8);
        for (let x = -subWidthPx / 2 + clipInset + 6 - tickOffset; x < subWidthPx / 2 - clipInset - 8; x += 28) {
            line(x, -3.8, x + 8, -3.8);
        }
        drawingContext.restore();
        noStroke();
        fill(58, 215, 255, 138);
        ellipse(0, -0.8, 7.5, 7.5);
    }

    pop();
}

function drawThinFilmCoating(subWidthPx) {
    const avgFilmH = getFilmBarHeightPx();
    if (avgFilmH <= 0.05) return;

    push();
    rectMode(CORNER);
    noStroke();
    const baseY = 10.4;
    const filmBandH = constrain(1.10 + avgFilmH * 0.82, 1.4, 9.4);

    const c = Math.floor(NUM_BINS / 2);
    const subBins = Math.max(6, Math.floor(subWidthPx / BIN_SIZE));
    const start = Math.max(0, c - Math.floor(subBins / 2));
    const end = Math.min(NUM_BINS - 1, c + Math.floor(subBins / 2));
    let localMax = 0;
    for (let i = start; i <= end; i++) {
        localMax = Math.max(localMax, Number.isFinite(visualFilmProfile[i]) ? visualFilmProfile[i] : 0);
    }
    localMax = Math.max(1, localMax);

    let filmBase = null;
    const activeSources = getActiveSources();
    if (STATE.filmComposition && Object.keys(STATE.filmComposition).length > 0) {
        let totalAmount = 0;
        let mixR = 0;
        let mixG = 0;
        let mixB = 0;
        Object.entries(STATE.filmComposition).forEach(([mat, amount]) => {
            if (!Number.isFinite(amount) || amount <= 0) return;
            const ref = MATERIALS[mat] || MATERIALS.Cu;
            const tint = ref.sputterTint || ref.color || [186, 208, 224];
            totalAmount += amount;
            mixR += tint[0] * amount;
            mixG += tint[1] * amount;
            mixB += tint[2] * amount;
        });
        if (totalAmount > 0) {
            filmBase = [
                Math.round(mixR / totalAmount),
                Math.round(mixG / totalAmount),
                Math.round(mixB / totalAmount)
            ];
        }
    }
    if (!filmBase && activeSources.length === 1) {
        const ref = MATERIALS[activeSources[0].material] || MATERIALS.Cu;
        filmBase = ref.sputterTint || ref.color || [186, 208, 224];
    }
    if (!filmBase) {
        const ref = MATERIALS[STATE.material] || MATERIALS.Cu;
        filmBase = ref.sputterTint || ref.color || [186, 208, 224];
    }
    const baseR = filmBase[0];
    const baseG = filmBase[1];
    const baseB = filmBase[2];
    const hiR = Math.min(255, baseR + 22);
    const hiG = Math.min(255, baseG + 22);
    const hiB = Math.min(255, baseB + 22);
    const shadowR = Math.max(0, baseR - 34);
    const shadowG = Math.max(0, baseG - 34);
    const shadowB = Math.max(0, baseB - 34);

    // Render the film directly on the underside of the substrate holder,
    // but let the visible coverage expand gradually with thickness.
    drawingContext.shadowBlur = 0;
    const visualAvg = getVisibleFilmThicknessNm();
    const filmStage = visualAvg < 0.05 ? 'nucleation' : visualAvg < 0.22 ? 'patchy' : 'continuous';
    const islandCoverage = constrain(map(visualAvg, 0.015, 0.80, 0.64, 0.98), 0.64, 0.98);
    const bandCoverage = constrain(map(visualAvg, 0.05, 1.6, 0.46, 1.0), 0.46, 1.0);
    const islandLeft = -subWidthPx * 0.5 * islandCoverage;
    const islandRight = subWidthPx * 0.5 * islandCoverage;
    const visibleLeft = -subWidthPx * 0.5 * bandCoverage;
    const visibleRight = subWidthPx * 0.5 * bandCoverage;
    const visibleWidth = visibleRight - visibleLeft;

    if (filmStage !== 'nucleation') {
        drawingContext.shadowBlur = filmStage === 'continuous' ? 11 : 7;
        drawingContext.shadowColor = `rgba(${baseR},${baseG},${baseB},0.17)`;
        fill(shadowR, shadowG, shadowB, filmStage === 'continuous' ? 46 : 26);
        rect(visibleLeft, baseY - 0.10, visibleWidth, filmBandH + 0.35, 2.8);
        fill(baseR, baseG, baseB, filmStage === 'continuous' ? 76 : 58);
        rect(visibleLeft, baseY, visibleWidth, filmBandH, 2.4);
        fill(hiR, hiG, hiB, filmStage === 'continuous' ? 44 : 28);
        rect(visibleLeft, baseY + filmBandH * 0.08, visibleWidth, filmBandH * 0.15, 1.8);
        fill(baseR, baseG, baseB, filmStage === 'continuous' ? 30 : 18);
        rect(visibleLeft, baseY + filmBandH * 0.24, visibleWidth, filmBandH * 0.48, 1.8);
        drawingContext.shadowBlur = 0;
    }

    for (let i = start; i <= end; i++) {
        const thickness = Math.max(0, visualFilmProfile[i] || 0);
        if (thickness <= 0) continue;
        const x = i * BIN_SIZE - CANVAS_W / 2;
        const isWithinIslandFootprint = !(x + BIN_SIZE < islandLeft || x > islandRight);
        const isWithinBandFootprint = !(x + BIN_SIZE < visibleLeft || x > visibleRight);
        if (filmStage === 'nucleation' && !isWithinIslandFootprint) continue;
        if (filmStage !== 'nucleation' && !isWithinBandFootprint) continue;
        const norm = constrain(thickness / localMax, 0, 1);
        const localBandH = constrain(filmBandH * (0.72 + norm * 0.16), filmBandH * 0.62, filmBandH * 0.9);
        const isIslandBin = nucleationSites.includes(i);
        const activeLeft = filmStage === 'nucleation' ? islandLeft : visibleLeft;
        const activeWidth = filmStage === 'nucleation' ? Math.max(1, islandRight - islandLeft) : Math.max(1, visibleWidth);
        const withinVisible = constrain((x - activeLeft) / activeWidth, 0, 1);
        const edgeFalloff = 1 - Math.abs(withinVisible - 0.5) * 1.35;
        const deterministicSeed = ((i * 37) % 100) / 100;
        let r, g, b;
        if ((STATE.growthMode === 'VW') ||
            (STATE.growthMode === 'SK' && STATE.skPhase === 'island' && isIslandBin) ||
            (STATE.growthMode === 'auto' && isIslandBin)) {
            r = lerp(baseR, Math.min(255, baseR + 28), norm);
            g = lerp(baseG, Math.min(255, baseG + 18), norm);
            b = lerp(baseB, Math.max(0, baseB - 6), norm);
        } else {
            r = lerp(baseR, hiR, norm);
            g = lerp(baseG, hiG, norm);
            b = lerp(baseB, hiB, norm);
        }
        if (filmStage === 'nucleation') {
            const shouldDrawIsland =
                norm > 0.035 ||
                isIslandBin ||
                (deterministicSeed < Math.max(0.12, edgeFalloff * 0.20) && thickness > Math.max(visualAvg * 0.012, 0.004));
            if (shouldDrawIsland) {
                const islandAlpha = 54 + norm * 72 + Math.max(0, edgeFalloff) * 16;
                fill(r, g, b, islandAlpha);
                ellipse(
                    x + BIN_SIZE * 0.5,
                    baseY + filmBandH * (0.62 + (1 - Math.max(0, edgeFalloff)) * 0.10),
                    0.95 + norm * 1.38 + Math.max(0, edgeFalloff) * 0.26,
                    0.58 + norm * 0.88
                );
            }
        } else if (filmStage === 'patchy') {
            fill(r, g, b, 118);
            rect(x, baseY, BIN_SIZE + 1.0, Math.max(0.85, localBandH * 0.76), 1.2);
            if (norm > 0.28 || isIslandBin) {
                fill(hiR, hiG, hiB, 38);
                rect(x, baseY, BIN_SIZE + 1.0, Math.max(0.28, localBandH * 0.12), 0.8);
            }
        } else {
            fill(r, g, b, 114);
            rect(x, baseY, BIN_SIZE + 1.0, Math.max(1.15, localBandH * 1.08), 1.2);
        }
    }
    if (filmStage !== 'nucleation') {
        fill(Math.min(255, hiR + 10), Math.min(255, hiG + 10), Math.min(255, hiB + 10), filmStage === 'continuous' ? 72 : 40);
        rect(visibleLeft, baseY, visibleWidth, 0.42, 0.8);
        if (filmStage === 'continuous') {
            fill(shadowR, shadowG, shadowB, 38);
            rect(visibleLeft, baseY + filmBandH - 0.34, visibleWidth, 0.34, 0.8);
        }
    }
    pop();
}

function drawLandingMapOverlay() {
    const diag = STATE.landingDiagnostics;
    if (!diag || !diag.radialHistogram || diag.totalLandings <= 0) return;
    const subWidthPx = STATE.subDiaInches * (300 / 4);
    const subLeft = -subWidthPx / 2;
    const bucketWidth = subWidthPx / 4;
    const overlayY = 3;
    push();
    noStroke();
    for (let i = 0; i < 4; i++) {
        const frac = diag.radialHistogram[i] / Math.max(1, diag.totalLandings);
        const alpha = map(frac, 0, 0.45, 10, 72, true);
        fill(0, 210, 255, alpha);
        rect(subLeft + i * bucketWidth, overlayY, bucketWidth - 1, 4, 2);
    }
    stroke(255, 210, 140, 32);
    strokeWeight(0.7);
    line(subLeft, overlayY + 6, subLeft + subWidthPx, overlayY + 6);
    pop();
}

function updateChart() {
    updateStaticYield();
    timeSec++;
    const maxDataPoints = 30; // Show last 30 seconds

    if (STATE.chartMode === 'power') {
        depChart.data.labels.push(Math.round(getTotalActivePower()));
    } else {
        depChart.data.labels.push(timeSec);
    }

    let rawRate = STATE.depositThisSecond;
    let rawYield = STATE.yieldDisplay || 0;

    // Quick Stats memory
    if (typeof STATE.maxYieldSeen === 'undefined') STATE.maxYieldSeen = 0;
    if (typeof STATE.rateHistory === 'undefined') STATE.rateHistory = [];

    STATE.maxYieldSeen = Math.max(STATE.maxYieldSeen, rawYield);
    STATE.rateHistory.push(rawRate);
    if (STATE.rateHistory.length > 60) STATE.rateHistory.shift();

    let avgRate = STATE.rateHistory.reduce((a, b) => a + b, 0) / Math.max(1, STATE.rateHistory.length);
    let statAvgEl = document.getElementById('stat-avg-rate');
    if (statAvgEl) statAvgEl.innerText = avgRate.toFixed(1);
    const statMaxYEl = document.getElementById(
        'stat-max-yield');
    if (statMaxYEl) {
        statMaxYEl.innerText =
            STATE.yieldDisplay.toFixed(2);
    }

    // Label already pushed above

    depChart.data.datasets[0].data.push(rawRate);
    depChart.data.datasets[1].data.push(rawYield);

    if (depChart.data.labels.length > maxDataPoints) {
        depChart.data.labels.shift();
        depChart.data.datasets[0].data.shift();
        depChart.data.datasets[1].data.shift();
    }

    // Apply smoothing if checked
    let smoothCb = document.getElementById('smoothTimeCheck');
    let needsRestore = false;
    let origData0, origData1;
    if (smoothCb && smoothCb.checked && depChart.data.datasets[0].data.length > 5) {
        needsRestore = true;
        origData0 = depChart.data.datasets[0].data.slice();
        origData1 = depChart.data.datasets[1].data.slice();
        depChart.data.datasets[0].data = movingAverage(origData0, 5);
        depChart.data.datasets[1].data = movingAverage(origData1, 5);
    }

    depChart.update();

    if (needsRestore) {
        depChart.data.datasets[0].data = origData0;
        depChart.data.datasets[1].data = origData1;
    }

    // Update Radial Profile Chart (Thickness vs Radius)
    // Convert bin raw atoms to 'nm' thickness proxy
    const uniformityMetrics = getUniformityMetrics();
    // Use the measured thickness profile and slightly stronger smoothing
    // so the chart reads like a physical film footprint rather than a bin-by-bin spike map.
    const subWidthPx = STATE.subDiaInches * (300 / 4);
    const subBins = Math.max(1, Math.floor(subWidthPx / BIN_SIZE));
    const c = Math.floor(NUM_BINS / 2);
    const start = Math.max(0, c - Math.floor(subBins / 2));
    const end = Math.min(NUM_BINS, c + Math.floor(subBins / 2));
    let thicknessData = movingAverage(uniformityMetrics.rawThickness.slice(start, end), 11).map(v => Number.isFinite(v) ? v : 0);
    let profileLabels = [];
    for (let i = start; i < end; i++) {
        profileLabels.push((i * BIN_SIZE) - (CANVAS_W / 2));
    }
    profileChart.data.labels = profileLabels;
    profileChart.data.datasets[0].data = thicknessData;
    // Color logic moved down

    // ---- Update Stats UI Once Per Second ----
    document.getElementById('stat-deposited').innerText = STATE.totalDeposited;

    // Substrate bin bounds â€” only measure within the physical substrate area
    let centerVal = uniformityMetrics.centerThicknessNm;
    let edgeVal = uniformityMetrics.edgeThicknessNm;
    document.getElementById('stat-center').innerText = centerVal.toFixed(2) + " nm";
    document.getElementById('stat-edge').innerText = edgeVal.toFixed(2) + " nm";

    // Average Thickness â€” substrate region only
    STATE.avgThickness = uniformityMetrics.avgThicknessNm;

    let nonUniformityPercent = uniformityMetrics.nonUniformityPercent;
    let uniformityPercent = uniformityMetrics.uniformityPercent;
    let uniEl = document.getElementById('stat-uniformity');
    // % Non-Uniformity: (Max âˆ’ Min) / Average Ã— 100% â€” substrate region only
    if (STATE.isRunning && timeSec < 10) {
        if (uniEl) uniEl.innerText = "Calculating...";
    } else if (STATE.avgThickness > 0 && uniformityPercent !== null) {
        if (uniEl) uniEl.innerText = uniformityPercent.toFixed(1) + "%";

        // Debug tooltip on the parent metric card
        if (uniEl && uniEl.parentElement) {
        let maxT = Math.max(...thicknessData);
        let minT = Math.min(...thicknessData);
            uniEl.parentElement.title = `Uniformity: ${uniformityPercent.toFixed(1)}% | Non-uniformity: ${nonUniformityPercent.toFixed(1)}% | Max: ${maxT.toFixed(2)}nm | Min: ${minT.toFixed(2)}nm | Avg: ${STATE.avgThickness.toFixed(2)}nm`;
        }
    } else {
        if (uniEl) uniEl.innerText = "100.0%";
    }

    STATE.lastUniformityMetrics = {
        nonUniformityPercent: nonUniformityPercent,
        uniformityPercent: uniformityPercent === null ? 100 : uniformityPercent,
        centerThicknessNm: Number.isFinite(centerVal) ? centerVal : 0,
        edgeThicknessNm: Number.isFinite(edgeVal) ? edgeVal : 0,
        avgThicknessNm: Number.isFinite(STATE.avgThickness) ? STATE.avgThickness : 0,
        rawThickness: uniformityMetrics.rawThickness
    };

    // Color-code radial profile: green for good uniformity (< 10%), red for poor (> 20%)
    if (nonUniformityPercent < 10) {
        profileChart.data.datasets[0].borderColor = 'rgba(0, 255, 157, 1)'; // Green
        profileChart.data.datasets[0].backgroundColor = 'rgba(0, 255, 157, 0.2)';
    } else if (nonUniformityPercent > 20) {
        profileChart.data.datasets[0].borderColor = 'rgba(255, 68, 102, 1)'; // Red
        profileChart.data.datasets[0].backgroundColor = 'rgba(255, 68, 102, 0.2)';
    } else {
        profileChart.data.datasets[0].borderColor = 'rgba(0, 210, 255, 1)'; // Cyan
        profileChart.data.datasets[0].backgroundColor = 'rgba(0, 210, 255, 0.2)';
    }

    profileChart.update();

    // --- Transport and uniformity diagnostics ---
    const lambda_m_diag = computeMeanFreePathMeters();
    const distance_m_diag = Math.max(0.02, STATE.distanceCM / 100);
    const scatteringRatio = calculateScatteringRatio(distance_m_diag, lambda_m_diag);
    const transportCode = classifyTransport(scatteringRatio);
    const uniformityCode = classifyUniformity(uniformityPercent);
    const statusText = generateProcessStatus(scatteringRatio, uniformityPercent);
    updateProcessDiagnostics(scatteringRatio, transportCode, uniformityPercent, uniformityCode, statusText);

    // --- Simulation Status HUD Logic ---
    let simStatusEl = document.getElementById('sim-status-hud');
    if (simStatusEl) {
        const tone = getDiagnosticTone(statusText, transportCode, uniformityCode);
        const toneMap = {
            green: { varName: 'var(--accent-green)', bg: 'rgba(0, 255, 157, 0.1)' },
            yellow: { varName: 'var(--accent-yellow)', bg: 'rgba(255, 229, 102, 0.1)' },
            orange: { varName: 'var(--accent-plasma)', bg: 'rgba(255, 140, 72, 0.1)' },
            red: { varName: 'var(--accent-red)', bg: 'rgba(255, 68, 102, 0.1)' }
        };
        const toneStyle = toneMap[tone] || toneMap.green;
        simStatusEl.style.color = toneStyle.varName;
        simStatusEl.style.borderColor = toneStyle.varName;
        simStatusEl.style.background = toneStyle.bg;
        simStatusEl.innerHTML = `<span class="st-dot" style="background:${toneStyle.varName}; box-shadow:0 0 6px ${toneStyle.varName}; margin:0; margin-right:8px;"></span> ${statusText}`;
    }

    // Energy Efficiency
    STATE.effectiveDepositionRate = STATE.depositThisSecond;
    let efficiency = STATE.effectiveDepositionRate / Math.max(1, getTotalActivePower());
    document.getElementById('stat-efficiency').innerText = efficiency.toFixed(efficiency < 1 ? 2 : 1) + " atoms/W";
    recordExportSnapshot(STATE.lastUniformityMetrics, scatteringRatio, transportCode, uniformityCode, statusText, efficiency);
    STATE.devDiagnostics.lastSecond = {
        timeSec,
        ionsSpawnedSec: STATE.devDiagnostics.ionsSpawnedSec,
        emittedPacketsSec: STATE.devDiagnostics.emittedPacketsSec,
        landedPacketsSec: STATE.devDiagnostics.landedPacketsSec,
        depositedUnitsSec: STATE.devDiagnostics.depositedUnitsSec,
        rateAtomsPerSecond: STATE.depositThisSecond
    };

    // Growth Mode display
    let gmEl = document.getElementById('stat-growth-mode');
    if (gmEl) {
        let modeLabels = { FM: 'Frank-van der Merwe', VW: 'Volmer-Weber', SK: 'Stranski-Krastanov', auto: 'Auto' };
        let resolved = STATE.growthMode;
        if (resolved === 'auto') {
            resolved = STATE.surfaceMobility > 0.6 ? 'FM' : (STATE.latticeMismatch > 0.07 ? 'SK' : 'VW');
        }
        let phaseTag = (resolved === 'SK') ? ` [${STATE.skPhase}]` : '';
        gmEl.innerText = (modeLabels[resolved] || resolved) + phaseTag;
        gmEl.style.color = resolved === 'FM' ? 'var(--accent-cyan)' : resolved === 'VW' ? '#e8903a' : 'var(--accent-yellow)';
    }

    // Status bar mirroring
    let sbRate = document.getElementById('sb-rate');
    if (sbRate) sbRate.innerText = STATE.depositThisSecond;
    let sbMfp = document.getElementById('sb-mfp');
    if (sbMfp) sbMfp.innerText = (computeMeanFreePathMeters() * 100).toFixed(2);

    STATE.depositThisSecond = 0; // Reset counter for next second
    STATE.devDiagnostics.ionsSpawnedSec = 0;
    STATE.devDiagnostics.emittedPacketsSec = 0;
    STATE.devDiagnostics.landedPacketsSec = 0;
    STATE.devDiagnostics.depositedUnitsSec = 0;
    STATE.devDiagnostics.ionsSpawnedSec = 0;
    STATE.devDiagnostics.emittedPacketsSec = 0;
    STATE.devDiagnostics.landedPacketsSec = 0;
    STATE.devDiagnostics.depositedUnitsSec = 0;

    updateThicknessTargetUI();
}

// Sigmund Formula Approximation â€” accepts optional matKey for per-source calculation
function calculateYield(power, matKey, sourceIdx) {
    const src = STATE.sources[sourceIdx] || STATE.sources[0];
    const typeMods = getPowerTypeModifiers(src ? src.powerType : 'DC');
    const discharge = getSourceDischarge(sourceIdx);
    const ionEnergyEV = discharge.ionEnergy;
    if (power < 5) return 0;

    const matProps = getMaterialProps(matKey);
    const thetaRad = estimateIonIncidenceAngleRadians(sourceIdx);
    let y = calculateYamamuraYield(ionEnergyEV, matProps, thetaRad) * typeMods.ionFlux;

    // Reactive sputtering: apply reduced-order poisoning on top of the clean-metal Yamamura baseline.
    const poisoning = sourceIdx !== undefined ? (STATE.reactiveState.poisoning[sourceIdx] || 0) : 0;
    const hysteresisPenalty = STATE.reactiveState.hysteresis * 0.12;
    const poisonFactor = (1.0 - poisoning * 0.72) * (1.0 - hysteresisPenalty);

    return Math.max(0, y * poisonFactor);
}

function updateStaticYield() {
    updateReactiveState();
    STATE.transportFactor = getTransportFactor();
    let totalY = 0;
    let weightedSticking = 0;
    let activeCount = 0;
    let totalCurrent = 0;
    STATE.sources.forEach((src, i) => {
        src.discharge = estimateDischargeForSource(src, i);
        if (src.active && src.power >= 80) {
            src.yield = calculateYield(src.power, src.material, i);
            totalY += src.yield;
            weightedSticking += getStickingCoefficient(i, src.discharge.ionEnergy * 0.015);
            totalCurrent += src.discharge.current;
            activeCount++;
        } else {
            src.yield = 0;
        }
    });
    STATE.stickingCoeff = activeCount > 0 ? (weightedSticking / activeCount) : 0.8;
    STATE.totalCurrent = totalCurrent;
    syncDerivedPowerState();
    STATE.yield = totalY;
    const _yieldScaleMap = {
        'Cu': 525, 'Al': 303, 'Ti': 295,
        'Zn': 174, 'Sn': 260, 'W': 344,
        'Ta': 216, 'Mo': 369
    };
    const _activeSrc = STATE.sources
        .filter(s => s.active && s.power >= 80)[0];
    const _matKey = _activeSrc
        ? (_activeSrc.material || 'Cu') : 'Cu';
    const _yieldScale =
        _yieldScaleMap[_matKey] || 525;
    STATE.yieldDisplay = STATE.yield * _yieldScale;
    STATE.illustrativeYield = totalY * (0.9 + STATE.magField / 0.12) * STATE.transportFactor * STATE.stickingCoeff;
    STATE.material = STATE.sources[0].material; // keep alias in sync
    document.getElementById('stat-yield').innerText = STATE.yieldDisplay.toFixed(2);
    let sbYield = document.getElementById('sb-yield');
    if (sbYield) sbYield.innerText = STATE.yieldDisplay.toFixed(2);
    // Per-gun yield readouts
    STATE.sources.forEach((src, i) => {
        let el = document.getElementById('src' + (i + 1) + 'YieldVal');
        if (el) el.innerText = (src.active && src.power >= 80) ? (src.yield * (_yieldScaleMap[src.material] || 525)).toFixed(2) : 'â€”';
    });
    updateRecipeSummary();
    updateControlRelevance();
    updateStartGuidance();
}

function resetSim() {
    ions = [];
    sputteredAtoms = [];
    for (let i = 0; i < NUM_BINS; i++) substrateProfile[i] = 0;
    visualFilmProfile = new Array(NUM_BINS).fill(0);
    for (let i = 0; i < NUM_BINS; i++) layerMap[i] = 0;
    nucleationSites = [];
    STATE.skPhase = 'layer';
    STATE.strainEnergy = 0.0;
    // Recompute surface mobility from current temperature
    STATE.surfaceMobility = Math.min(1.0, Math.max(0.05, (STATE.temperature - 100) / 900));
    // Recompute critical thickness from lattice mismatch (higher mismatch = fewer layers)
    STATE.criticalThickness = Math.max(1.0, 8.0 - STATE.latticeMismatch * 120);
    STATE.totalDeposited = 0;
    STATE.avgThickness = 0;
    STATE.depositThisSecond = 0;
    STATE.yield = STATE.yield || 0;
    STATE.illustrativeYield = 0;
    STATE.effectiveDepositionRate = 0;
    STATE.transportFactor = getTransportFactor();
    STATE.stickingCoeff = 0.8;
    STATE.totalCurrent = 0;
    STATE.representativeVoltage = 0;
    STATE.representativeIonEnergy = 0;
    STATE.filmComposition = {};
    STATE.exportHistory = [];
    STATE.lastUniformityMetrics = { nonUniformityPercent: 0, uniformityPercent: 100, centerThicknessNm: 0, edgeThicknessNm: 0, avgThicknessNm: 0 };
    STATE.lastProcessDiagnostics = { scatteringRatio: 0, transportCode: 'BALLISTIC', uniformityCode: 'EXCELLENT', statusText: 'STABLE PROCESS' };
    STATE.devDiagnostics = { ionsSpawnedSec: 0, emittedPacketsSec: 0, landedPacketsSec: 0, depositedUnitsSec: 0, lastSecond: null };
    STATE.advisorRunTargetMs = null;
    STATE.advisorTargetThicknessNm = null;
    STATE.advisorAutoPauseMessage = '';
    STATE.thicknessTargetActive = false;
    STATE.thicknessTargetAchieved = false;
    document.getElementById('thickness-target-achieved').style.display = 'none';
    updateThicknessTargetUI();
    resetLandingDiagnostics();
    STATE.reactiveState = { poisoning: [0, 0, 0], hysteresis: 0 };
    STATE.sources.forEach(s => { s.deposited = 0; s.yield = 0; s.spawnAccumulator = 0; s.discharge = null; });
    timeSec = 0;
    _timerReset();
    if (depChart) {
        depChart.data.labels = [STATE.chartMode === 'power' ? Math.round(getTotalActivePower()) : 0];
        depChart.data.datasets[0].data = [0];
        if (depChart.data.datasets[1]) depChart.data.datasets[1].data = [0];
        depChart.update();
    }
    // Return to idle
    if (STATE.isRunning) {
        STATE.isRunning = false;
        noLoop();
    }
    STATE._everStarted = false;
    _updateStartBtnUI();
    // Reset metric display to dashes
    let ids = ['stat-yield', 'stat-deposited', 'stat-center', 'stat-uniformity', 'stat-avg-rate', 'stat-max-yield', 'stat-edge', 'stat-efficiency'];
    let dashes = { 'stat-yield': '0.00', 'stat-deposited': '0', 'stat-center': '0.00 nm', 'stat-uniformity': '--', 'stat-avg-rate': '0.0', 'stat-max-yield': '0.00', 'stat-edge': '0.00', 'stat-efficiency': '0' };
    ids.forEach(id => { let el = document.getElementById(id); if (el) el.innerText = dashes[id] || 'â€”'; });
    updateProcessDiagnostics(0, 'BALLISTIC', 100, 'EXCELLENT', 'STABLE PROCESS');
    updateStaticYield();
    // Re-draw static chamber
    redraw();
}


function resetLabDefaults() {
    document.getElementById('pressureSlider').value = 15;
    document.getElementById('tempSlider').value = 300;
    document.getElementById('magSlider').value = 0.03;
    document.getElementById('argonSlider').value = 100;
    document.getElementById('gasCompSlider').value = 0;
    document.getElementById('speedSlider').value = 1.0;
    document.getElementById('distanceSlider').value = 10;
    document.getElementById('targetDiaSlider').value = 3;
    document.getElementById('subDiaSlider').value = 4;
    document.getElementById('densitySlider').value = 100;

    // Trigger input events to update STATE
    ['power', 'pressure', 'temp', 'mag', 'argon', 'gasComp', 'speed', 'distance', 'targetDia', 'subDia', 'density'].forEach(id => {
        let el = document.getElementById(id + 'Slider');
        if (el) el.dispatchEvent(new Event('input'));
    });

    document.getElementById('materialSelect').value = 'Cu';
    document.getElementById('materialSelect').dispatchEvent(new Event('change'));

    // Turn all guns off in UI
    [1, 2, 3].forEach(n => {
        let cb = document.getElementById('src' + n + 'Active');
        if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
    });

    const presetSelect = document.getElementById('presetSelect');
    if (presetSelect) presetSelect.value = '';
    const advisorPanel = document.getElementById('aiAdvisorResult');
    if (advisorPanel) advisorPanel.classList.add('hidden');
    lastAdvisorRecommendation = null;
    syncAdvisorDefaultsFromState();

    resetSim(); // also returns to idle
}

// ----------------- ENTITIES -----------------

class Ion {
    constructor(sourceIdx = 0, srcX = null) {
        this.sourceIdx = sourceIdx;
        let targetWidthPx = STATE.targetDiaInches * (120 / 3);
        let gunCenterX = (srcX !== null) ? srcX : CANVAS_W / 2;
        const discharge = getSourceDischarge(this.sourceIdx);

        // Ion type based on gas mixture
        this.type = (random(100) < STATE.oxygenPercent) ? 'O2' : 'Ar';
        this.mass = this.type === 'O2' ? 32 : 40;

        // Spawn distributed through plasma volume (between substrate and target)
        // not all lined up at the top â€” fill the plasma column randomly
        let plasmaTop = SUBSTRATE_Y + (TARGET_Y - SUBSTRATE_Y) * 0.06;
        let plasmaBot = TARGET_Y - (TARGET_Y - SUBSTRATE_Y) * 0.15;
        this.x = random(gunCenterX - targetWidthPx * 0.45, gunCenterX + targetWidthPx * 0.45);
        this.x = constrain(this.x, CHAMBER_ML + WALL_W + 5, CANVAS_W - CHAMBER_MR - WALL_W - 5);
        this.y = random(plasmaTop, plasmaBot);

        // Ions accelerate DOWNWARD toward target cathode through the sheath
        const energySpeed = Math.sqrt(Math.max(40, discharge.ionEnergy)) * 0.19;
        let baseSpeed = random(1.8, 3.2) + energySpeed;
        this.vy = baseSpeed;
        // Small EÃ—B lateral drift â€” not straight vertical
        this.vx = random(-0.8, 0.8);
        this.age = 0;
    }

    update() {
        let gunX = STATE.gunPositions ? STATE.gunPositions[this.sourceIdx] : null;
        if (gunX == null) gunX = CANVAS_W / 2;

        this.age++;

        // Gentle EÃ—B lateral oscillation â€” ions spiral slightly as they fall
        let wobble = Math.sin(this.age * 0.3) * 0.15;
        this.vx += wobble;
        this.vx *= 0.88;

        const stepX = this.vx * STATE.simSpeed;
        const stepY = this.vy * STATE.simSpeed;
        const nextY = this.y + stepY;
        const crossesSubstrate = this.y > SUBSTRATE_Y && nextY <= SUBSTRATE_Y;

        if (crossesSubstrate) {
            this.x += stepX;
            this.y = SUBSTRATE_Y;
        } else {
            this.x += stepX;
            this.y = nextY;
        }

        // Kill at chamber walls
        if (this.x < CHAMBER_ML + WALL_W || this.x > CANVAS_W - CHAMBER_MR - WALL_W) {
            this.y = TARGET_Y + 10;
        }

        // Kill when ion reaches target â€” it causes sputtering (handled by SputteredAtom spawn)
        // Also kill if it drifts too far laterally
        let _tw = STATE.targetDiaInches * (120 / 3);
        if (Math.abs(this.x - gunX) > _tw * 1.6) {
            this.y = TARGET_Y + 10;
        }
    }

    draw() {
        noStroke();
        let scaleF = CANVAS_W / 800;
        let wallDist = Math.min(
            Math.abs(this.x - (CHAMBER_ML + WALL_W)),
            Math.abs((CANVAS_W - CHAMBER_MR - WALL_W) - this.x)
        );
        let wallFade = constrain(map(wallDist, 0, WALL_SOFT, 0.2, 1.0), 0.2, 1.0);

        // How close to target â€” ions brighten as they enter the sheath and accelerate
        let progress = constrain((this.y - SUBSTRATE_Y) / (TARGET_Y - SUBSTRATE_Y), 0, 1);
        let sheathBright = constrain(map(progress, 0.6, 0.95, 0, 1), 0, 1); // brighten last 35%

        if (this.type === 'O2') {
            let alpha = lerp(60, 150, sheathBright) * wallFade;
            drawingContext.shadowBlur = sheathBright > 0.3 ? 5 : 2;
            drawingContext.shadowColor = 'rgba(180,40,220,0.4)';
            fill(160, 40, 200, alpha);
            ellipse(this.x, this.y, 2.2 * scaleF, 2.2 * scaleF);
        } else {
            let alpha = lerp(50, 180, sheathBright) * wallFade;
            let r = lerp(80, 140, sheathBright);
            let g = lerp(140, 180, sheathBright);
            // Short acceleration streak â€” gets longer near target
            let streakLen = lerp(1, 5, sheathBright) * this.vy * 0.4;
            if (streakLen > 1) {
                stroke(r, g, 255, alpha * 0.5);
                strokeWeight(0.5 * scaleF);
                line(this.x, this.y, this.x - this.vx, this.y - streakLen);
                noStroke();
            }
            drawingContext.shadowBlur = sheathBright > 0.4 ? 6 : 2;
            drawingContext.shadowColor = `rgba(${r},${g},255,0.45)`;
            fill(r, g, 255, alpha);
            ellipse(this.x, this.y, lerp(2.0, 3.2, sheathBright) * scaleF, lerp(2.0, 3.2, sheathBright) * scaleF);
        }
        drawingContext.shadowBlur = 0;
    }
}

function sampleEmissionOriginX(sourceIdx = 0, impactX = CANVAS_W / 2) {
    let gunCenterX = STATE.gunPositions ? STATE.gunPositions[sourceIdx] : null;
    if (gunCenterX == null) gunCenterX = CANVAS_W / 2;
    const targetWidthPx = STATE.targetDiaInches * (120 / 3);
    const substrateWidthPx = STATE.subDiaInches * (300 / 4);
    const matchedCoverage = constrain(STATE.targetDiaInches / Math.max(0.1, STATE.subDiaInches), 0.55, 1.35);
    const racetrackRadius = targetWidthPx * constrain(0.28 + (matchedCoverage - 0.8) * 0.18, 0.22, 0.42);
    const lobeSpread = targetWidthPx * 0.18;
    const impactBlend = constrain(0.62 + (STATE.distanceCM - 8) * 0.04 + Math.max(0, matchedCoverage - 0.8) * 0.12, 0.48, 0.82);
    const side = random() < 0.5 ? -1 : 1;
    const racetrackX = gunCenterX + side * racetrackRadius + random(-lobeSpread, lobeSpread);
    return constrain(lerp(impactX, racetrackX, impactBlend), gunCenterX - targetWidthPx * 0.78, gunCenterX + targetWidthPx * 0.78);
}

class SputteredAtom {
    constructor(startX, startY, materialKey, sourceIdx = 0) {
        this.x = startX;
        this.y = startY;
        this.stuck = false;
        this.sourceIdx = sourceIdx;
        this.material = materialKey || STATE.material;

        // Reduced-order cosine-family angular emission with Thompson-like energy sampling
        let angle = sampleCosineEmissionAngle(this.sourceIdx);
        this.energy = sampleThompsonLikeEnergy(this.sourceIdx);
        let speed = Math.sqrt(this.energy) * 1.6;
        this.vx = Math.cos(angle) * speed;
        this.vy = -Math.abs(Math.sin(angle) * speed); // always upward
        const pressureBroadening = constrain(STATE.pressure / 18, 0, 1.4);
        const distanceBroadening = constrain((STATE.distanceCM - 6) / 6, 0, 1.3);
        const targetBroadening = constrain((STATE.targetDiaInches - 3) / 2, 0, 1.2);
        const matchedCoverage = constrain(STATE.targetDiaInches / Math.max(0.1, STATE.subDiaInches), 0.55, 1.35);
        const geometryBroadening = Math.max(0, matchedCoverage - 0.75) * 0.65 + targetBroadening * 0.35;
        this.vx += random(-0.22, 0.22)
            - pressureBroadening * 0.05
            + random(-0.42, 0.42) * distanceBroadening
            + random(-0.60, 0.60) * geometryBroadening
            + random(-0.22, 0.22) * targetBroadening;
        this.transportWeight = 1.0;
    }

    update() {
        if (this.stuck) return;

        // Mean Free Path Calculation (Î»)
        // Constants
        let lambda_m = computeMeanFreePathMeters();

        // Scale lambda to our 800px simulation space 
        // Let's assume the 800px canvas represents roughly 0.2 meters (20 cm chamber width)
        let pixels_per_meter = 800 / 0.2;
        let lambda_px = lambda_m * pixels_per_meter;

        // Frame distance traveled
        let distTraveled = dist(0, 0, this.vx, this.vy);

        // Probability of scattering in this frame = Distance Traveled / Mean Free Path
        let scatterProb = distTraveled / lambda_px;

        if (random() < scatterProb) {
            // Realistic gas scattering â€” small deflection, not random explosion
            let deflect = random(-0.6, 0.6);
            this.vx += deflect;
            this.vy += random(-0.3, 0.3);
            this.vx *= 0.88;
            this.vy *= 0.88;
            this.energy *= 0.92;
            this.transportWeight *= 0.985;
        }

        const saStepX = this.vx * STATE.simSpeed;
        const saStepY = this.vy * STATE.simSpeed;
        const saNextY = this.y + saStepY;
        const saCrossesSubstrate = this.y > SUBSTRATE_Y && saNextY <= SUBSTRATE_Y;

        if (saCrossesSubstrate) {
            this.x += saStepX;
            this.y = SUBSTRATE_Y;
        } else {
            this.x += saStepX;
            this.y = saNextY;
        }

        // Hard kill at chamber wall â€” no reflection
        if (this.x < CHAMBER_ML + WALL_W || this.x > CANVAS_W - CHAMBER_MR - WALL_W) {
            this.stuck = true; return;
        }

        // Kill atoms that drift too far horizontally from active gun
        let gunX = STATE.gunPositions ? STATE.gunPositions[this.sourceIdx] : null;
        if (gunX == null) gunX = CANVAS_W / 2;

        let _tgtWpx = STATE.targetDiaInches * (120 / 3);
        let _subWpx = STATE.subDiaInches * (300 / 4);
        let maxDrift = Math.max(_tgtWpx, _subWpx) * 1.5;
        if (Math.abs(this.x - gunX) > maxDrift) {
            this.stuck = true; return;
        }

        // Top edge collision â€” Substrate Deposition
        if (this.y <= SUBSTRATE_Y) {
            // Fix 4: kill atoms that miss the substrate disc horizontally
            let _sWpx = STATE.subDiaInches * (300 / 4);
            let _sLeft = CANVAS_W / 2 - _sWpx / 2;
            let _sRight = CANVAS_W / 2 + _sWpx / 2;
            if (this.x < _sLeft || this.x > _sRight) {
                this.stuck = true; return; // missed disc â€” lost to chamber
            }
            const stickingCoeff = getStickingCoefficient(this.sourceIdx, this.energy);
            if (random() < stickingCoeff) {
                handleDeposition(this.x, this.sourceIdx, this.transportWeight * STATE.transportFactor * stickingCoeff);
                this.stuck = true;
                this.y = SUBSTRATE_Y;
            } else {
                this.vy *= -0.5; // bounce back down
            }
        }

        // Culling if drifted backwards out of bounds (Bottom)
        if (this.y > TARGET_Y) {
            this.stuck = true; // remove
        }
    }

    draw() {
        let partOp = (typeof STATE !== 'undefined' && STATE.opPart !== undefined) ? (STATE.opPart * (STATE.lowClutterMode ? 0.4 : 1.0)) : 1.0;
        noStroke();
        let speed = dist(0, 0, this.vx, this.vy);
        let heat = constrain(map(speed, 0, 12, 0, 1), 0, 1);

        let matProps = MATERIALS[this.material] ? MATERIALS[this.material] : MATERIALS[STATE.material];
        let matColor = matProps.sputterTint || matProps.color;
        let mr = matColor[0], mg = matColor[1], mb = matColor[2];

        // Hot = slightly lighter toward material colour, cool = dim
        let r = lerp(mr * 0.6, mr, heat);
        let g = lerp(mg * 0.6, mg, heat);
        let b = lerp(mb * 0.6, mb, heat);
        let wallDist = Math.min(
            Math.abs(this.x - (CHAMBER_ML + WALL_W)),
            Math.abs((CANVAS_W - CHAMBER_MR - WALL_W) - this.x)
        );
        let wallFade = constrain(map(wallDist, 0, WALL_SOFT, 0.18, 1.0), 0.18, 1.0);
        let a = map(heat, 0, 1, 80, 200) * partOp * wallFade;

        // Subtle glow â€” only for fast hot atoms
        if (heat > 0.6) {
            drawingContext.shadowBlur = 4;
            drawingContext.shadowColor = `rgba(${Math.round(mr)},${Math.round(mg)},${Math.round(mb)},0.4)`;
        }

        let scaleF = CANVAS_W / 800;
        fill(r, g, b, a);
        // Small fixed size â€” sputtered atoms are not huge glowing balls
        let sz = lerp(1.5, 3.0, heat) * scaleF;
        circle(this.x, this.y, sz);

        drawingContext.shadowBlur = 0;
    }
}

function handleDeposition(x, sourceIdx = 0, depositionWeight = 1.0) {
    if (!Number.isFinite(x) || !Number.isFinite(depositionWeight)) return;
    let subWidthPx = STATE.subDiaInches * (300 / 4);
    let subLeft = CANVAS_W / 2 - subWidthPx / 2;
    let subRight = CANVAS_W / 2 + subWidthPx / 2;
    if (x < subLeft || x > subRight) return;

    let densityScale = Math.max(0, depositionWeight) / Math.max(0.2, STATE.particleDensity);
    if (!Number.isFinite(densityScale) || densityScale <= 0) return;
    let depositedAmount = densityScale * DEPOSITION_UNITS_PER_LANDING;
    STATE.totalDeposited += depositedAmount;
    STATE.depositThisSecond += depositedAmount;
    STATE.devDiagnostics.landedPacketsSec += 1;
    STATE.devDiagnostics.depositedUnitsSec += depositedAmount;
    if (STATE.sources[sourceIdx]) {
        STATE.sources[sourceIdx].deposited += depositedAmount;
    }

    let bin = constrain(floor(x / BIN_SIZE), 0, NUM_BINS - 1);
    const kernelInfo = depositWithKernel(x, depositedAmount, densityScale, sourceIdx);
    bin = kernelInfo.bin;

    let mode = STATE.growthMode;
    if (mode === 'auto') {
        let mob = STATE.surfaceMobility;
        let mis = STATE.latticeMismatch;
        if (mis > 0.07) mode = 'SK';
        else if (mob > 0.6) mode = 'FM';
        else mode = 'VW';
    }

    if (mode === 'VW') {
        const nucleationProb = 0.04 * (1.0 - STATE.surfaceMobility * 0.5);
        const captureRadius = Math.max(6, Math.round(kernelInfo.sigmaBins * 0.6));
        const nearIsland = nucleationSites.some(site => Math.abs(site - bin) <= captureRadius);
        if (nearIsland) {
            bin = nucleationSites.reduce((a, b) => Math.abs(a - bin) < Math.abs(b - bin) ? a : b);
        } else if (Math.random() < nucleationProb || nucleationSites.length === 0) {
            nucleationSites.push(bin);
        }
    } else if (mode === 'FM') {
        const monolayerThreshold = 40;
        const currentLayer = layerMap[bin];
        const layerFill = substrateProfile[bin] - currentLayer * monolayerThreshold;
        if (layerFill >= monolayerThreshold) {
            layerMap[bin] = currentLayer + 1;
        }
    } else if (mode === 'SK') {
        let subBins = [];
        let subLB = Math.max(0, floor((CANVAS_W / 2 - subWidthPx / 2) / BIN_SIZE));
        let subRB = Math.min(NUM_BINS - 1, floor((CANVAS_W / 2 + subWidthPx / 2) / BIN_SIZE));
        for (let i = subLB; i <= subRB; i++) subBins.push(layerMap[i]);
        let avgLayers = subBins.length > 0 ? subBins.reduce((a, b) => a + b, 0) / subBins.length : 0;
        STATE.strainEnergy = STATE.latticeMismatch * avgLayers * 12;

        if (avgLayers < STATE.criticalThickness) {
            STATE.skPhase = 'layer';
            if (substrateProfile[bin] - layerMap[bin] * 40 >= 40) {
                layerMap[bin] += 1;
            }
        } else {
            STATE.skPhase = 'island';
            const nucleationProb = Math.min(0.08, 0.03 * (1 + STATE.strainEnergy) * (1.0 - STATE.surfaceMobility * 0.5));
            const captureRadius = Math.max(6, Math.round(kernelInfo.sigmaBins * 0.7));
            const nearIsland = nucleationSites.some(site => Math.abs(site - bin) <= captureRadius);
            if (nearIsland) {
                bin = nucleationSites.reduce((a, b) => Math.abs(a - bin) < Math.abs(b - bin) ? a : b);
            } else if (Math.random() < nucleationProb || nucleationSites.length === 0) {
                nucleationSites.push(bin);
            }
        }
    }
}

function startIntro() {
    STATE.mode = 'intro';
    STATE.introProgress = 0.0;
    document.getElementById('canvas-container').parentElement.classList.add('intro-mode');
    resetSim();
}

// ----------------- P5 DRAW LOOP -----------------

// Draws a completely static chamber frame (no particles, no glow, no motion)
// Called once via redraw() on load and on reset so the canvas is never a black void.
function drawIdleChamber() {
    // Compute geometry (mirrors the same calculations in draw())
    SUBSTRATE_Y = Math.max(42, CANVAS_H * 0.07);
    TARGET_Y = Math.min(CANVAS_H * 0.72, SUBSTRATE_Y + (STATE.distanceCM * 28));
    let targetWidthPx = STATE.targetDiaInches * (120 / 3);
    let subWidthPx = STATE.subDiaInches * (300 / 4);

    // â”€â”€ position HTML overlay labels â”€â”€
    positionChamberLabels();

    // Deep vacuum background â€” solid, no trail
    background(3, 5, 15);

    // â”€â”€ Chamber Walls â€” left wall pushed inward by CHAMBER_ML â”€â”€
    push(); noStroke();
    // Left dead zone (outside chamber)
    fill(2, 4, 10, 255); rect(0, 0, CHAMBER_ML, CANVAS_H);
    // Left wall
    fill(68, 72, 80, 90); rect(CHAMBER_ML, 0, WALL_W, CANVAS_H);
    fill(160, 166, 178, 44); rect(CHAMBER_ML + WALL_W - 2, 0, 2, CANVAS_H);
    // Right wall
    fill(68, 72, 80, 90); rect(CANVAS_W - CHAMBER_MR - WALL_W, 0, WALL_W, CANVAS_H);
    fill(160, 166, 178, 44); rect(CANVAS_W - CHAMBER_MR - WALL_W, 0, 2, CANVAS_H);
    // Right dead zone
    fill(2, 4, 10, 255); rect(CANVAS_W - CHAMBER_MR, 0, CHAMBER_MR, CANVAS_H);
    // Top wall
    fill(60, 64, 74, 110); rect(CHAMBER_ML, 0, CANVAS_W - CHAMBER_ML - CHAMBER_MR, WALL_W);
    fill(170, 176, 188, 36); rect(CHAMBER_ML, WALL_W - 2, CANVAS_W - CHAMBER_ML - CHAMBER_MR, 2);
    fill(145, 152, 168, 120);
    ellipse(CHAMBER_ML + WALL_W * 0.5, WALL_W * 0.5, 4, 4);
    ellipse(CANVAS_W - CHAMBER_MR - WALL_W * 0.5, WALL_W * 0.5, 4, 4);
    stroke(140, 146, 160, 18); strokeWeight(1);
    line(CHAMBER_ML + WALL_W, WALL_W, CHAMBER_ML + WALL_W, CANVAS_H);
    line(CANVAS_W - CHAMBER_MR - WALL_W, WALL_W, CANVAS_W - CHAMBER_MR - WALL_W, CANVAS_H);
    line(CHAMBER_ML + WALL_W, WALL_W, CANVAS_W - CHAMBER_MR - WALL_W, WALL_W);
    pop();

    // Solid backing plate
    noStroke(); fill(2, 3, 8, 200);
    rect(CHAMBER_ML, TARGET_Y + 4, CANVAS_W - CHAMBER_ML - CHAMBER_MR, CANVAS_H - TARGET_Y);

    // â”€â”€ 3D cathodes + substrate (same renderer used during live simulation) â”€â”€
    drawTarget3D();

    // â”€â”€ Mean Free Path display â”€â”€
    let kB = 1.38e-23, T = STATE.temperature, d = 3.5e-10;
    let P_pa = Math.max(0.1, STATE.pressure) * 0.133322;
    let lambda_m = (kB * T) / (Math.sqrt(2) * Math.PI * Math.pow(d, 2) * P_pa);
    let lambda_px = lambda_m * (800 / 0.2);
    push(); noStroke(); textSize(12); textAlign(RIGHT);
    fill(100, 180, 220, 180);
    text('Mean Free Path (\u03BB): ', CANVAS_W - 20 - Math.min(200, lambda_px) - 5, SUBSTRATE_Y - 22);
    fill(255, 229, 102, 200);
    text(`${(lambda_m * 100).toFixed(2)} cm`, CANVAS_W - 22, SUBSTRATE_Y - 22);
    let dlpx = Math.min(200, lambda_px);
    stroke(255, 220, 80, 120); strokeWeight(1.5);
    line(CANVAS_W - 20 - dlpx, SUBSTRATE_Y - 10, CANVAS_W - 20, SUBSTRATE_Y - 10);
    line(CANVAS_W - 20 - dlpx, SUBSTRATE_Y - 15, CANVAS_W - 20 - dlpx, SUBSTRATE_Y - 5);
    line(CANVAS_W - 20, SUBSTRATE_Y - 15, CANVAS_W - 20, SUBSTRATE_Y - 5);
    pop();

    // â”€â”€ System Ready indicator (minimal) â”€â”€
    push(); noStroke();
    fill(255, 255, 255, 0); // fully removed
    pop();
}

// Helper: update the Start/Pause/Resume button appearance, status HUD, and status bar indicators
function _updateStartBtnUI() {
    let startBtn = document.getElementById('btn-start');
    let sbSystem = document.getElementById('sb-system');
    let sbPlasma = document.getElementById('sb-plasma');
    let sbFlux = document.getElementById('sb-flux');

    if (!STATE.isRunning) {
        // Idle / paused â€” show Start or Resume
        if (startBtn) {
            const key = STATE._everStarted ? 'btn-start-resume' : 'btn-start-init';
            startBtn.innerText = window.TRANSLATIONS[window.currentLang][key] || (STATE._everStarted ? 'Resume' : 'Start Process');
            startBtn.style.background = 'rgba(90,170,114,0.22)';
            startBtn.style.borderColor = 'var(--accent-green)';
            startBtn.style.color = 'var(--accent-green)';
        }
        // Dim the status bar indicators
        if (sbSystem) sbSystem.style.opacity = '0.25';
        if (sbPlasma) sbPlasma.style.opacity = '0.25';
        if (sbFlux) sbFlux.style.opacity = '0.25';
    } else {
        // Running â€” activate button as Pause
        if (startBtn) {
        startBtn.innerText = window.TRANSLATIONS[window.currentLang]['btn-start-pause'] || 'Pause';
            startBtn.style.background = 'rgba(200,168,64,0.15)';
            startBtn.style.borderColor = 'var(--accent-yellow)';
            startBtn.style.color = 'var(--accent-yellow)';
        }
        // Restore status bar indicators to full opacity
        if (sbSystem) sbSystem.style.opacity = '1';
        if (sbPlasma) sbPlasma.style.opacity = '1';
        if (sbFlux) sbFlux.style.opacity = '1';
    }
    updateRecipeSummary();
    updateStartGuidance();
}

// â”€â”€ Process Timer helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _timerStart() {
    if (_timerRunning) return;
    _timerRunning = true;
    let lastTick = Date.now();
    _timerInterval = setInterval(() => {
        let now = Date.now();
        _timerMs += now - lastTick;
        lastTick = now;
        _timerRender();
        const advisorTargetSec = STATE.advisorRunTargetMs ? Math.ceil(STATE.advisorRunTargetMs / 1000) : 0;
        if (STATE.isRunning && advisorTargetSec && timeSec >= advisorTargetSec) {
            STATE.isRunning = false;
            STATE.paused = true;
            _timerPause();
            _updateStartBtnUI();
            noLoop();
            updateStartGuidance();
            const warn = document.getElementById('start-warning');
            if (warn && STATE.advisorAutoPauseMessage) {
                warn.innerHTML = STATE.advisorAutoPauseMessage;
                warn.classList.remove('is-error', 'is-info');
                warn.classList.add('is-info');
            }
        }
    }, 100);
    _timerSetStatus('RUN');
}

function _timerPause() {
    if (!_timerRunning) return;
    _timerRunning = false;
    clearInterval(_timerInterval);
    _timerInterval = null;
    _timerSetStatus('PAUSE');
}

function _timerReset() {
    _timerRunning = false;
    clearInterval(_timerInterval);
    _timerInterval = null;
    _timerMs = 0;
    _timerRender();
    _timerSetStatus('IDLE');
}

function _timerRender() {
    let totalSec = Math.max(0, Math.floor(timeSec));
    let mins = Math.floor(totalSec / 60);
    let secs = totalSec % 60;
    let tenths = 0;
    let disp = document.getElementById('timer-display');
    let msDisp = document.getElementById('timer-ms');
    if (disp) disp.textContent = String(mins).padStart(2,'0') + ':' + String(secs).padStart(2,'0');
    if (msDisp) msDisp.textContent = '.' + tenths;
}

function _timerSetStatus(status) {
    let el = document.getElementById('timer-status');
    if (!el) return;
    el.textContent = status;
    let colors = { RUN: 'var(--accent-green)', PAUSE: 'var(--accent-yellow)', IDLE: 'var(--text-secondary)' };
    el.style.color = colors[status] || 'var(--text-secondary)';
    // Also pulse the timer display green when running
    let disp = document.getElementById('timer-display');
    if (disp) disp.style.color = status === 'RUN' ? 'var(--accent-green)' : status === 'PAUSE' ? 'var(--accent-yellow)' : 'var(--text-secondary)';
}

function toggleSputtering() {
    if (!STATE.isRunning) {
        // â”€â”€ START / RESUME â”€â”€

        // Check if any guns are active with sufficient power
        let activeGuns = STATE.sources
            .map((s, i) => ({ ...s, idx: i }))
            .filter(s => s.active && s.power >= 80);

        if (activeGuns.length === 0) {
            updateStartGuidance(true);
            console.warn('[Sputtering] Start blocked â€” no active guns with power â‰¥ 80W');
            return;
        }

        STATE.isRunning = true;
        STATE._everStarted = true;
        STATE.paused = false;

        // Hide warning if it was visible
        updateStartGuidance();

        // Prime initial gun positions so the very first frame can spawn ions
        let numActive = activeGuns.length;
        let gunSpread = STATE.targetDiaInches * (60 / 3) * 2.6;
        activeGuns.forEach((gun, ai) => {
            let srcX;
            if (numActive === 1) srcX = CANVAS_W / 2;
            else if (numActive === 2) srcX = ai === 0 ? CANVAS_W / 2 - gunSpread * 0.5 : CANVAS_W / 2 + gunSpread * 0.5;
            else srcX = ai === 0 ? CANVAS_W / 2 : ai === 1 ? CANVAS_W / 2 - gunSpread * 0.6 : CANVAS_W / 2 + gunSpread * 0.6;
            STATE.gunPositions[gun.idx] = srcX;
        });

        // Small initial burst so plasma is visible immediately
        activeGuns.forEach(gun => {
            let srcX = STATE.gunPositions[gun.idx];
            if (srcX == null) return;
            gun.spawnAccumulator = 0;
            gun.discharge = estimateDischargeForSource(gun, gun.idx);
            let burst = constrain(Math.round(getIonSpawnRatePerFrame(gun.idx) * STARTUP_BURST_SCALE), 1, 3);
            for (let b = 0; b < burst; b++) ions.push(new Ion(gun.idx, srcX));
        });

        _updateStartBtnUI();
        _timerStart();
        loop();
    } else {
        // â”€â”€ PAUSE â”€â”€
        STATE.isRunning = false;
        STATE.paused = true;
        _updateStartBtnUI();
        _timerPause();
        noLoop();
        // Do NOT call redraw() here â€” that would wipe the canvas to the idle chamber.
        // noLoop() freezes the current frame exactly as-is.
    }
}

function draw() {
    try {
        // Safety gate: when not running, draw the static idle chamber instead
        if (!STATE.isRunning) {
            drawIdleChamber();
            return;
        }
        if (STATE.paused) return;

        if (STATE.mode === 'intro' || STATE.mode === 'transition') {
            drawIntroSequence();
            return;
        }

        // In Tutorial mode, we still render the simulation in the background, but wait for user input
        // so we just let it run normally (or we could freeze it, but running is more visually appealing)

        updateVisualFilmProfile();

        // Deep vacuum background with much less trail persistence to look more rigid
        background(3, 5, 15, 90);

        // â”€â”€ METALLIC CHAMBER WALLS â€” left wall inset by CHAMBER_ML â”€â”€
        push();
        noStroke();
        // Left dead zone (outside chamber â€” pure black)
        drawingContext.shadowBlur = 0;
        fill(2, 4, 10, 255); rect(0, 0, CHAMBER_ML, CANVAS_H);
        // Left wall
        drawingContext.shadowBlur = 6;
        drawingContext.shadowColor = 'rgba(190,190,200,0.10)';
        fill(68, 72, 80, 90); rect(CHAMBER_ML, 0, WALL_W, CANVAS_H);
        fill(160, 166, 178, 44); rect(CHAMBER_ML + WALL_W - 2, 0, 2, CANVAS_H);
        // Right dead zone
        drawingContext.shadowBlur = 0;
        fill(2, 4, 10, 255); rect(CANVAS_W - CHAMBER_MR, 0, CHAMBER_MR, CANVAS_H);
        // Right wall
        drawingContext.shadowBlur = 6;
        drawingContext.shadowColor = 'rgba(190,190,200,0.10)';
        fill(68, 72, 80, 90); rect(CANVAS_W - CHAMBER_MR - WALL_W, 0, WALL_W, CANVAS_H);
        fill(160, 166, 178, 44); rect(CANVAS_W - CHAMBER_MR - WALL_W, 0, 2, CANVAS_H);
        // Top wall
        fill(60, 64, 74, 110); rect(CHAMBER_ML, 0, CANVAS_W - CHAMBER_ML - CHAMBER_MR, WALL_W);
        fill(170, 176, 188, 36); rect(CHAMBER_ML, WALL_W - 2, CANVAS_W - CHAMBER_ML - CHAMBER_MR, 2);
        drawingContext.shadowBlur = 0;
        // Corner bolts
        fill(145, 152, 168, 120);
        ellipse(CHAMBER_ML + WALL_W * 0.5, WALL_W * 0.5, 4, 4);
        ellipse(CANVAS_W - CHAMBER_MR - WALL_W * 0.5, WALL_W * 0.5, 4, 4);
        // Wall tick marks
        fill(132, 138, 152, 36);
        for (let ty = 50; ty < CANVAS_H - 10; ty += 55) {
            rect(CHAMBER_ML + WALL_W, ty, 3, 1);
            rect(CANVAS_W - CHAMBER_MR - WALL_W - 3, ty, 3, 1);
        }
        // Subtle inner cyan glow line
        drawingContext.shadowBlur = 0;
        stroke(140, 146, 160, 18); strokeWeight(1);
        line(CHAMBER_ML + WALL_W, WALL_W, CHAMBER_ML + WALL_W, CANVAS_H);
        line(CANVAS_W - CHAMBER_MR - WALL_W, WALL_W, CANVAS_W - CHAMBER_MR - WALL_W, CANVAS_H);
        line(CHAMBER_ML + WALL_W, WALL_W, CANVAS_W - CHAMBER_MR - WALL_W, WALL_W);
        drawingContext.shadowBlur = 0;
        pop();

        // Solid backing plate â€” nothing exists below the target
        noStroke();
        fill(2, 3, 8, 200);
        rect(CHAMBER_ML, TARGET_Y + 4, CANVAS_W - CHAMBER_ML - CHAMBER_MR, CANVAS_H - TARGET_Y);

        // Magnetron housing below target â€” educational cross-section (1D mode only)
        if (!STATE.viewMode3D) {
            push();
            // Backing plate
            fill(15, 18, 28, 240);
            noStroke();
            rect(CHAMBER_ML, TARGET_Y + 4, CANVAS_W - CHAMBER_ML - CHAMBER_MR, CANVAS_H - TARGET_Y);

            // Backing plate top surface
            drawingContext.shadowBlur = 8;
            drawingContext.shadowColor = 'rgba(255,107,53,0.4)';
            stroke(180, 70, 20, 120);
            strokeWeight(2);
            line(CHAMBER_ML, TARGET_Y + 5, CANVAS_W - CHAMBER_MR, TARGET_Y + 5);
            drawingContext.shadowBlur = 0;

            // Magnet poles (N-S-N pattern under target)
            let cx = CANVAS_W / 2;
            let ty = TARGET_Y + 30;
            let twPx = STATE.targetDiaInches * (120 / 3);

            // Center pole (S)
            fill(20, 40, 120, 180); stroke(40, 80, 200, 150); strokeWeight(1);
            rect(cx - 15, ty, 30, 50, 4);
            fill(200, 220, 255, 200); noStroke(); textSize(11); textAlign(CENTER);
            text('S', cx, ty + 28);

            // Outer poles (N)
            fill(120, 20, 20, 180); stroke(200, 60, 60, 150); strokeWeight(1);
            rect(cx - twPx * 0.35 - 15, ty, 30, 45, 4);
            rect(cx + twPx * 0.35 - 15, ty, 30, 45, 4);
            fill(255, 200, 200, 200); noStroke();
            text('N', cx - twPx * 0.35, ty + 25);
            text('N', cx + twPx * 0.35, ty + 25);

            // Magnetic field arc labels
            stroke(100, 150, 255, 60); strokeWeight(1); noFill();
            arc(cx, TARGET_Y + 5, twPx * 0.7, 60, PI, TWO_PI);
            arc(cx - twPx * 0.35, TARGET_Y + 5, 60, 40, PI, TWO_PI);
            arc(cx + twPx * 0.35, TARGET_Y + 5, 60, 40, PI, TWO_PI);

            // Label removed
            pop();
        } // end !viewMode3D magnetron housing

        // â”€â”€ GUN LABELS â€” drawn below the target for all 3 guns â”€â”€
        if (!STATE.viewMode3D) {
            const GUN_COLORS = [[0, 210, 255], [255, 112, 67], [140, 102, 255]];
            const gunWord = window.TRANSLATIONS[window.currentLang]['gun'] || 'GUN';
            const GUN_LABELS = [gunWord + ' 1', gunWord + ' 2', gunWord + ' 3'];
            // Compute label positions for all 3 guns (even inactive)
            let allPositions = [null, null, null];
            let aSrcs = STATE.sources.map((s, i) => ({ ...s, idx: i })).filter(s => s.active && s.power >= 80);
            let n = aSrcs.length;
            let sp = STATE.targetDiaInches * (60 / 3) * 2.6;
            aSrcs.forEach((gun, ai) => {
                let x;
                if (n === 1) x = CANVAS_W / 2;
                else if (n === 2) x = CANVAS_W / 2 + (ai === 0 ? -sp * 0.5 : sp * 0.5);
                else x = ai === 0 ? CANVAS_W / 2 : ai === 1 ? CANVAS_W / 2 - sp * 0.6 : CANVAS_W / 2 + sp * 0.6;
                allPositions[gun.idx] = x;
            });
            // For inactive guns, spread them evenly below the target for labeling
            let gunSlotX = [CANVAS_W * 0.28, CANVAS_W * 0.5, CANVAS_W * 0.72];
            STATE.sources.forEach((src, i) => {
                let posX = allPositions[i] !== null ? allPositions[i] : gunSlotX[i];
                let isActive = (src.active && src.power >= 80 && allPositions[i] !== null);
                let [cr, cg, cb] = GUN_COLORS[i];
                let matName = (MATERIALS[src.material] ? MATERIALS[src.material].name : src.material).toUpperCase();
                let labelY = TARGET_Y + 55;

                push();
                // Colored disc
                drawingContext.shadowBlur = isActive ? 12 : 0;
                drawingContext.shadowColor = `rgba(${cr},${cg},${cb},0.8)`;
                fill(cr, cg, cb, isActive ? 200 : 60);
                noStroke();
                ellipse(posX, labelY - 10, isActive ? 16 : 10, isActive ? 7 : 4);

                // Gun label text
                textSize(9);
                textAlign(CENTER);
                textStyle(BOLD);
                drawingContext.shadowBlur = isActive ? 8 : 0;
                drawingContext.shadowColor = `rgba(${cr},${cg},${cb},0.9)`;
                fill(cr, cg, cb, isActive ? 255 : 0); // hide inactive
                text(GUN_LABELS[i], posX, labelY + 5);

                // Material sub-label
                textStyle(NORMAL);
                drawingContext.shadowBlur = 0;
                fill(cr, cg, cb, isActive ? 180 : 0); // hide inactive
                textSize(8);
                text(matName + (isActive ? '' : ''), posX, labelY + 16);

                // Power sub-label â€” bigger and brighter
                if (isActive) {
                    fill(220, 235, 255, 220);
                    textSize(9);
                    textStyle(BOLD);
                    text(src.powerType + ' ' + src.power + 'W', posX, labelY + 27);
                    textStyle(NORMAL);
                }
                pop();
            });
        }




        // Update Dynamic Geometry (Base scale: 10cm = 350px gap)
        SUBSTRATE_Y = Math.max(42, CANVAS_H * 0.07);
        TARGET_Y = Math.min(CANVAS_H * 0.72, SUBSTRATE_Y + (STATE.distanceCM * 28));
        let targetWidthPx = STATE.targetDiaInches * (120 / 3); // 3 inches = 120px base
        let subWidthPx = STATE.subDiaInches * (300 / 4); // 4 inches = 300px base

        // Dynamically position educational labels to match simulation physics coordinates
        positionChamberLabels();

        // â”€â”€ SUBSTRATE VISUAL â”€â”€
        push();
        translate(CANVAS_W / 2, SUBSTRATE_Y);
        rectMode(CENTER);
        drawingContext.shadowBlur = 0;
        stroke(86, 92, 104, 135);
        strokeWeight(0.9);
        fill(28, 30, 38, 252);
        rect(0, -18, subWidthPx, 14, 3);
        pop();

        // â”€â”€ TARGET HOLDER BACKPLATE (bottom) â€” standalone hollow box (1D only) â”€â”€
        if (!STATE.viewMode3D) {
            push();
            translate(CANVAS_W / 2, TARGET_Y);
            rectMode(CENTER);
            drawingContext.shadowBlur = 12;
            drawingContext.shadowColor = 'rgba(255,100,20,0.6)';
            stroke(255, 120, 30, 200);
            strokeWeight(1.5);
            fill(60, 20, 0, 80);
            rect(0, 0, targetWidthPx * 2.8, 16, 1);
            drawingContext.shadowBlur = 0;
            pop();
        } // end target holder 1D only

        // Calculate lambda for physics and UI display
        let kB = 1.38e-23;
        let T = STATE.temperature;
        let d = 3.5e-10;
        let P_pa = Math.max(0.1, STATE.pressure) * 0.133322;
        let lambda_m = (kB * T) / (Math.sqrt(2) * Math.PI * Math.pow(d, 2) * P_pa);
        let pixels_per_meter = 800 / 0.2;
        let lambda_px = lambda_m * pixels_per_meter;

        // Live Lambda Indicator UI â€” premium styled
        push();
        noStroke();
        textSize(12);
        textAlign(RIGHT);
        // Label
        fill(100, 180, 220, 180);
        text('Mean Free Path (\u03BB): ', CANVAS_W - 20 - Math.min(200, lambda_px) - 5, SUBSTRATE_Y - 22);
        // Value with glow
        drawingContext.shadowBlur = 8;
        drawingContext.shadowColor = 'rgba(255,229,102,0.8)';
        fill(255, 229, 102, 220);
        text(`${(lambda_m * 100).toFixed(2)} cm`, CANVAS_W - 22, SUBSTRATE_Y - 22);
        drawingContext.shadowBlur = 0;
        // Scale bar
        let displayLambdaPx = Math.min(200, lambda_px);
        drawingContext.shadowBlur = 6;
        drawingContext.shadowColor = 'rgba(255,229,102,0.5)';
        stroke(255, 220, 80, 160);
        strokeWeight(1.5);
        line(CANVAS_W - 20 - displayLambdaPx, SUBSTRATE_Y - 10, CANVAS_W - 20, SUBSTRATE_Y - 10);
        line(CANVAS_W - 20 - displayLambdaPx, SUBSTRATE_Y - 15, CANVAS_W - 20 - displayLambdaPx, SUBSTRATE_Y - 5);
        line(CANVAS_W - 20, SUBSTRATE_Y - 15, CANVAS_W - 20, SUBSTRATE_Y - 5);
        drawingContext.shadowBlur = 0;
        pop();

        // â”€â”€ SUBSTRATE VISUAL â”€â”€
        if (STATE.substrateRotEnabled) {
            push();
            translate(CANVAS_W / 2, SUBSTRATE_Y - 18);
            let rotSpeed = 0.02 * (getTotalActivePower() > 100 && !STATE.paused ? STATE.simSpeed : 0);
            if (!STATE.substrateRot) STATE.substrateRot = 0;
            STATE.substrateRot += rotSpeed;

            drawSubstrateHolder(subWidthPx);
            drawThinFilmCoating(subWidthPx);
            pop();
            drawGrowingFilmBar();
        } else {
            push();
            translate(CANVAS_W / 2, SUBSTRATE_Y - 18);
            drawSubstrateHolder(subWidthPx);
            drawThinFilmCoating(subWidthPx);
            pop();
            drawGrowingFilmBar();
        }



        // â”€â”€ TARGET (CATHODE) â€” switches between 1D cross-section and 3D view â”€â”€
        if (STATE.viewMode3D) {
            drawTarget3D();
        } else {
            let matColor = MATERIALS[STATE.material].color;
            let mr = matColor[0], mg = matColor[1], mb = matColor[2];

            // Outer erosion halo
            let raceTrackWidth = targetWidthPx * 0.6;
            push();
            translate(CANVAS_W / 2, TARGET_Y);

            // Deep radial glow under target
            drawingContext.shadowBlur = 0;
            for (let ring = 3; ring >= 0; ring--) {
                let rr = (targetWidthPx * 0.55) * (0.5 + ring * 0.18);
                fill(mr, mg * 0.4, mb * 0.2, 18 - ring * 3);
                noStroke();
                ellipse(0, 0, rr * 2, rr * 0.7);
            }

            // Target body â€” metallic gradient via two ellipses
            fill(mr * 0.25, mg * 0.25, mb * 0.25, 240);
            noStroke();
            ellipse(0, 0, targetWidthPx, targetWidthPx * 0.45);
            // Surface highlight
            fill(mr * 0.55, mg * 0.55, mb * 0.55, 180);
            ellipse(0, -4, targetWidthPx * 0.85, targetWidthPx * 0.3);

            // Erosion racetrack â€” glowing ring
            // Racetrack glow only when at least one gun is hot
            let _racePower = Math.max(0, ...STATE.sources.map(s => (s.active ? s.power : 0)));
            if (_racePower >= 80) {
                let racePulseA = sin(millis() * 0.008) * 0.15 + 0.85;
                let raceAlpha = map(_racePower, 80, 500, 0.4, 1.0);
                drawingContext.shadowBlur = 14;
                drawingContext.shadowColor = `rgba(${mr},${Math.round(mg * 0.4)},50,0.8)`;
                strokeWeight(3.5);
                stroke(255, 80 + sin(millis() * 0.01) * 30, 30, 140 * racePulseA * raceAlpha);
                noFill();
                ellipse(0, 0, raceTrackWidth, raceTrackWidth * 0.45);
                drawingContext.shadowBlur = 0;

                // Deep erosion groove
                let displayErosion = Math.min(60, STATE.erosionLevel);
                strokeWeight(5 + displayErosion * 0.12);
                stroke(mr * 0.25, mg * 0.25, mb * 0.25, 200);
                ellipse(0, 0, raceTrackWidth, raceTrackWidth * 0.45);
                noStroke();
            }

            // Magnetron ring glow pulses
            for (let r = 0; r < 3; r++) {
                let rr = (targetWidthPx * 0.28) * (0.7 + r * 0.35);
                let a = sin(millis() * 0.006 + r * 1.2) * 20 + 50;
                drawingContext.shadowBlur = 8;
                drawingContext.shadowColor = `rgba(${mr},${Math.round(mg * 0.5)},255,0.5)`;
                stroke(mr * 0.7, mg * 0.3, 255, a);
                strokeWeight(r === 1 ? 2.5 : 1.2);
                noFill();
                ellipse(0, 0, rr * 2, rr * 0.8);
            }
            drawingContext.shadowBlur = 0;

            // Hot center spot
            let hotA = 120 + sin(millis() * 0.015) * 40;
            fill(255, 240, 180, hotA * (Math.max(1, getTotalActivePower()) / 300));
            noStroke();
            ellipse(0, -3, 28, 14);

            pop();

        } // end 1D target else

        // Target Erosion Racetrack (Circular ring on the target)
        let _maxGunPower = Math.max(0, ...STATE.sources.map(s => (s.active ? s.power : 0)));
        if (!STATE.paused && _maxGunPower >= 80) {
            STATE.erosionLevel += (_maxGunPower * 0.00005) + (STATE.magField * 0.01);
        }

        // Draw Intense Plasma Glow (premium deep-space style)

        // Opacity Modifiers
        let clutterAlpha = STATE.lowClutterMode ? 0.4 : 1.0;
        let glowOp = STATE.opGlow * clutterAlpha;
        let fieldOp = STATE.opField;
        let elecOp = STATE.opElec;
        let partOp = STATE.opPart * clutterAlpha;

        // â”€â”€ CALCULATE GUN POSITIONS â”€â”€
        // This must be done every frame for all possible guns so physics and labels stay synced.
        let targetR_px = STATE.targetDiaInches * 20;
        let spacing3D = targetR_px * 2.5;
        let spacing1D = STATE.targetDiaInches * (60 / 3) * 2.6;
        let aSrcs = STATE.sources.map((s, i) => ({ ...s, idx: i })).filter(s => s.active && s.power >= 80);
        let numActive = aSrcs.length;

        STATE.sources.forEach((src, i) => {
            if (STATE.viewMode3D) {
                // Fixed 3D Slots: Gun 1 (idx 0) = Center, Gun 2 (idx 1) = Left, Gun 3 (idx 2) = Right
                if (i === 0) STATE.gunPositions[i] = CANVAS_W / 2;
                else if (i === 1) STATE.gunPositions[i] = CANVAS_W / 2 - spacing3D * 0.6;
                else if (i === 2) STATE.gunPositions[i] = CANVAS_W / 2 + spacing3D * 0.6;
            } else {
                // 1D Mode: Positions depend on how many are active (centering behavior)
                if (!src.active || src.power < 80) {
                    STATE.gunPositions[i] = null;
                } else {
                    // Which active gun index is this?
                    let activeIdx = aSrcs.findIndex(as => as.idx === i);
                    if (numActive === 1) STATE.gunPositions[i] = CANVAS_W / 2;
                    else if (numActive === 2) STATE.gunPositions[i] = CANVAS_W / 2 + (activeIdx === 0 ? -spacing1D * 0.5 : spacing1D * 0.5);
                    else STATE.gunPositions[i] = activeIdx === 0 ? CANVAS_W / 2 : activeIdx === 1 ? CANVAS_W / 2 - spacing1D * 0.6 : CANVAS_W / 2 + spacing1D * 0.6;
                }
            }
        });

        // Current active guns for the per-gun loops below
        let activeGuns = aSrcs;

        // Draw plasma for each active gun
        activeGuns.forEach((gun, ai) => {
            let srcX = STATE.gunPositions[gun.idx];
            if (srcX === null) return;
            let gunPower = gun.power;
            if (!gun.active || gunPower < 80) return;

            let rBase = lerp(139, 180, STATE.oxygenPercent / 50.0);
            let gBase = lerp(0, 80, STATE.oxygenPercent / 50.0);
            let bBase = 255;
            let confinementFactor = map(STATE.magField, 0, 0.1, 1.2, 0.8);
            let plasmaWidth = targetWidthPx * confinementFactor / Math.max(1, numActive * 0.7);
            let plasmaHeight = 60 + (gunPower / 8);
            let plasmaAlpha = constrain(map(gunPower, 80, 500, 0.3, 1.0), 0.3, 1.0);
            let pulse = sin(timeSec * 5 + ai * 1.5 + (millis() / 200.0)) * 0.1 + 1.0;
            let flicker = random(-5, 5);


            push();
            translate(srcX, TARGET_Y - 10);

            // â”€â”€ Outermost diffuse atmospheric glow â”€â”€
            drawingContext.shadowBlur = 0;
            noStroke();
            fill(rBase, gBase, bBase, 12 * pulse * glowOp * plasmaAlpha);
            ellipse(0, -plasmaHeight * 0.55, plasmaWidth * 1.3, plasmaHeight * 1.2);

            // â”€â”€ Outer dome (violet) â”€â”€
            fill(rBase, gBase, bBase, 32 * pulse * glowOp * plasmaAlpha);
            ellipse(0, -plasmaHeight / 2 + 20, plasmaWidth, plasmaHeight);

            // â”€â”€ Mid dome (brighter, tighter) â”€â”€
            fill(rBase + 40, gBase + 30, bBase, 65 * pulse * glowOp * plasmaAlpha);
            ellipse(0, -plasmaHeight / 2 + 30, plasmaWidth * 0.78, plasmaHeight * 0.68);

            // â”€â”€ Inner core region glow â”€â”€
            drawingContext.shadowBlur = 20;
            drawingContext.shadowColor = `rgba(${Math.round(rBase + 60)},${Math.round(gBase + 60)},255,0.6)`;
            fill(rBase + 60, gBase + 60, bBase, 90 * pulse * glowOp * plasmaAlpha);
            ellipse(0, -plasmaHeight / 2 + 40, plasmaWidth * 0.5, plasmaHeight * 0.45);
            drawingContext.shadowBlur = 0;

            // â”€â”€ Intense white/yellow racetrack hotspots â”€â”€
            let coreWidth = (targetWidthPx * 0.66) * confinementFactor / Math.max(1, numActive * 0.7);
            drawingContext.shadowBlur = 16;
            drawingContext.shadowColor = 'rgba(255,240,160,0.9)';
            fill(255, 255, 200, (160 + flicker * 2) * glowOp * plasmaAlpha);
            ellipse(-coreWidth * 0.4, -14, 28, 18 + abs(flicker));
            ellipse(coreWidth * 0.4, -14, 28, 18 + abs(flicker));
            // Central connecting bright haze
            fill(255, 255, 255, 200 * glowOp * plasmaAlpha);
            ellipse(0, -14, coreWidth * 0.9, 22 + abs(flicker));
            drawingContext.shadowBlur = 0;

            // â”€â”€ HQ Filamentary Streamers â”€â”€
            if (STATE.hqPlasma) {
                let numFilaments = Math.floor(gunPower / 80);
                strokeWeight(1.2);
                noFill();
                for (let fi = 0; fi < numFilaments; fi++) {
                    let originX = (fi % 2 === 0) ? random(-45, -22) : random(22, 45);
                    let originY = -14;
                    let endX = constrain(originX + random(-22, 22), -plasmaWidth / 2, plasmaWidth / 2);
                    let endY = -plasmaHeight + random(10, 30);
                    let nOffset = millis() * 0.005 + fi * 10 + gun.idx * 100;
                    let cp1X = originX + (noise(nOffset) - 0.5) * 45;
                    let cp1Y = originY - 28;
                    let cp2X = endX + (noise(nOffset + 100) - 0.5) * 45;
                    let cp2Y = endY + 18;
                    let fc = fi % 3;
                    if (fc === 0) stroke(200, 240, 255, 160 * pulse * glowOp);
                    else if (fc === 1) stroke(220, 180, 255, 140 * pulse * glowOp);
                    else stroke(255, 255, 200, 170 * pulse * glowOp);
                    drawingContext.shadowBlur = 6;
                    drawingContext.shadowColor = 'rgba(180,160,255,0.5)';
                    bezier(originX, originY, cp1X, cp1Y, cp2X, cp2Y, endX, endY);
                }
                drawingContext.shadowBlur = 0;
            }

            // â”€â”€ Magnetic Field Lines (glowing cyan arcs) â”€â”€
            if (STATE.drawMagLines) {
                push();
                translate(0, 0); // already translated to target center
                strokeWeight(1);
                noFill();
                let numLines = Math.floor(map(STATE.magField, 0, 0.1, 3, 15));
                for (let i = 0; i < numLines; i++) {
                    let alpha = map(i, 0, numLines, 70, 15);
                    drawingContext.shadowBlur = i < 4 ? 6 : 0;
                    drawingContext.shadowColor = 'rgba(0,210,255,0.4)';
                    stroke(0, 180 - i * 8, 255, alpha * fieldOp);
                    let w = 80 + (i * 12);
                    let h = 40 + (i * 15 * confinementFactor);
                    arc(0, 0, w, h, PI, TWO_PI);
                }
                drawingContext.shadowBlur = 0;
                pop();
            }

            // â”€â”€ Electron Spirals (glowing cyan-green trails) â”€â”€
            if (STATE.drawElectrons) {
                if (!STATE._electronTrails) STATE._electronTrails = [];
                if (random() < 0.3 + (gunPower / 500)) {
                    let eConfine = (120 * confinementFactor) / Math.max(1, numActive * 0.8);
                    STATE._electronTrails.push({
                        x: random(-eConfine / 2, eConfine / 2),
                        y: TARGET_Y - random(10, 40),
                        srcX: srcX,
                        life: 22
                    });
                }
                push();
                translate(0, 0);
                for (let i = STATE._electronTrails.length - 1; i >= 0; i--) {
                    let el = STATE._electronTrails[i];
                    let px = el.x;
                    let py = el.y - TARGET_Y + 10;
                    el.x += random(-10, 10);
                    el.x = constrain(el.x, -65, 65);
                    el.y += sin(frameCount * 0.5 + el.life) * 3;
                    let ny = el.y - TARGET_Y + 10;
                    let lifeRatio = el.life / 22;
                    drawingContext.shadowBlur = 8;
                    drawingContext.shadowColor = 'rgba(0,255,200,0.7)';
                    stroke(0, 255, 180, 200 * lifeRatio * elecOp);
                    strokeWeight(1.5);
                    line(px, py, el.x, ny);
                    // Bright electron dot
                    noStroke();
                    fill(100, 255, 220, 240 * lifeRatio * elecOp);
                    circle(el.x, ny, 3.5);
                    drawingContext.shadowBlur = 0;
                    el.life--;
                    if (el.life <= 0) STATE._electronTrails.splice(i, 1);
                }
                pop();
            }

            pop();
        }); // end forEach active gun

        // Safety ceiling — prevents frame rate collapse on low-end devices
        const activeGunCount = STATE.sources
            ? STATE.sources.filter(s =>
                s.active && s.power >= 80).length
            : 1;

        const MAX_IONS = Math.min(300,
            120 + (activeGunCount - 1) * 60);
        const MAX_ATOMS = Math.min(600,
            300 + (activeGunCount - 1) * 100);
        if (ions.length > MAX_IONS) ions.splice(0, ions.length - MAX_IONS);
        if (sputteredAtoms.length > MAX_ATOMS) sputteredAtoms.splice(0, sputteredAtoms.length - MAX_ATOMS);

        // â”€â”€ ION SPAWN â€” guaranteed every N frames per active gun (no random gate) â”€â”€
        let newIonsSpawned = 0;
        STATE.sources.forEach((src, si) => {
            if (!src.active || src.power < 80) return;
            let srcX = STATE.gunPositions[si];
            if (srcX === null || srcX === undefined) return;
            src.discharge = estimateDischargeForSource(src, si);
            src.spawnAccumulator = (src.spawnAccumulator || 0) + getIonSpawnRatePerFrame(si);
            while (src.spawnAccumulator >= 1) {
                ions.push(new Ion(si, srcX));
                src.spawnAccumulator -= 1;
                newIonsSpawned++;
                STATE.devDiagnostics.ionsSpawnedSec += 1;
            }
            if (random() < src.spawnAccumulator * 0.12) {
                ions.push(new Ion(si, srcX));
                newIonsSpawned++;
                STATE.devDiagnostics.ionsSpawnedSec += 1;
                src.spawnAccumulator = Math.max(0, src.spawnAccumulator - 0.25);
            }
        });

        if (STATE.isRunning) {
            // â”€â”€ IMPACT FLASHES â”€â”€
            if (!STATE.flashes) STATE.flashes = [];
            for (let f = STATE.flashes.length - 1; f >= 0; f--) {
                let flash = STATE.flashes[f];
                noStroke();
                if (flash.type === 'spark') {
                    drawingContext.shadowBlur = 5;
                    drawingContext.shadowColor = 'rgba(255,120,30,0.45)';
                    fill(255, 100 + flash.life * 10, 20, flash.life * 40);
                    ellipse(flash.x, flash.y, 3 + (7 - flash.life), 3 + (7 - flash.life));
                } else {
                    drawingContext.shadowBlur = 10;
                    drawingContext.shadowColor = 'rgba(255,255,180,0.55)';
                    fill(255, 240, 160, flash.life * 22);
                    ellipse(flash.x, flash.y, 7 + (12 - flash.life * 1.1), 7 + (12 - flash.life * 1.1));
                    fill(255, 255, 255, flash.life * 15);
                    ellipse(flash.x, flash.y, 3.5, 3.5);
                }
                drawingContext.shadowBlur = 0;
                flash.life--;
                if (flash.life <= 0) STATE.flashes.splice(f, 1);
            }

            // â”€â”€ PROCESS IONS â”€â”€
            for (let i = ions.length - 1; i >= 0; i--) {
                let ion = ions[i];
                ion.update();
                ion.draw();
                let targetWidthPx = STATE.targetDiaInches * 40;

                // Fix: Check distance against the specific gun this ion was spawned from
                let gunX = STATE.gunPositions[ion.sourceIdx] || CANVAS_W / 2;
                let d = dist(ion.x, ion.y, gunX, TARGET_Y);

                if (d <= targetWidthPx) { // Relaxed to full width to ensure impact
                    // â”€â”€ SPUTTERED ATOM EJECTION â”€â”€
                    // Scale emitted particle packets with the live yield instead of forcing
                    // a nearly fixed burst at every impact.
                    let srcState = STATE.sources[ion.sourceIdx] || STATE.sources[0] || { power: 0, yield: 0 };
                    let sourceYield = srcState.yield || STATE.yield;
                    let activeCount = Math.max(1, getActiveSources().length);
                    let packetExpectation = (Math.max(0, sourceYield) * SPUTTER_PACKET_SCALE) / Math.pow(activeCount, MULTI_GUN_PACKET_NORM_EXP);
                    let atomCount = Math.floor(packetExpectation);
                    if (random() < (packetExpectation - atomCount)) atomCount += 1;
                    if (timeSec < 2 && atomCount === 0 && sourceYield > 0.01 && random() < 0.18) {
                        atomCount = 1;
                    }
                    for (let j = 0; j < atomCount; j++) {
                        let gunMat = (STATE.sources[ion.sourceIdx] && STATE.sources[ion.sourceIdx].material) || STATE.material;
                        const emitX = sampleEmissionOriginX(ion.sourceIdx, ion.x);
                        sputteredAtoms.push(new SputteredAtom(emitX, ion.y, gunMat, ion.sourceIdx));
                    }
                    STATE.devDiagnostics.emittedPacketsSec += atomCount;
                    STATE.flashes.push({ x: ion.x, y: ion.y, life: 10 });
                    ions.splice(i, 1);
                } else if (ion.y > TARGET_Y + 5) {
                    ions.splice(i, 1);
                }
            }

            // â”€â”€ PROCESS SPUTTERED ATOMS â”€â”€
            for (let i = sputteredAtoms.length - 1; i >= 0; i--) {
                let atom = sputteredAtoms[i];
                atom.update();
                if (!atom.stuck) {
                    atom.draw();
                } else {
                    sputteredAtoms.splice(i, 1);
                }
            }
        }
    } catch (err) {
        let errDiv = document.createElement('div');
        errDiv.style = "position:fixed; top:10%; left:10%; width:80%; padding:20px; background:red; color:white; font-size:24px; z-index:9999;";
        errDiv.innerHTML = "<strong>CRITICAL DRAW ERROR:</strong><br>" + err.message;
        document.body.appendChild(errDiv);
        noLoop();
    }
}

// ----------------- INTRO SEQUENCE - â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function drawIntroSequence() {
    background(10);

    // Update State
    if (STATE.mode === 'intro') {
        // Just hold the view for a moment then automatically start transition
        STATE.introProgress += 0.005;
        if (STATE.introProgress > 0.1) {
            STATE.mode = 'transition';
        }
    } else if (STATE.mode === 'transition') {
        STATE.introProgress += 0.003; // dictates zoom speed (~5-6 secs)
        if (STATE.introProgress >= 1.0) {
            document.getElementById('canvas-container').parentElement.classList.remove('intro-mode');

            // Check if guided mode is enabled
            if (document.getElementById('guidedModeCheck').checked) {
                startTutorial();
            } else {
                STATE.mode = 'simulation';
            }
            return;
        }
    }

    // Camera Math
    push();
    // Use an easing function for smoothness (ease-in-out curve)
    let t = Math.max(0, (STATE.introProgress - 0.1) / 0.9);
    let ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

    // Focus target is where the magnetron sits inside the chamber (bottom center)
    let targetFocusX = CANVAS_W * 0.5;
    let targetFocusY = CANVAS_H * 0.8;

    // Zoom scale from 1x to 15x
    let currentScale = lerp(1, 15, ease);
    translate(CANVAS_W / 2, CANVAS_H / 2);
    scale(currentScale);
    translate(-lerp(CANVAS_W / 2, targetFocusX, ease), -lerp(CANVAS_H / 2, targetFocusY, ease));

    // Draw External Chamber (Stylized 2D/3D representation)

    // Gas/Plasma Glow leaking through viewport
    noStroke();
    fill(50, 100, 200, 100 * (1 - ease));
    ellipse(CANVAS_W / 2, CANVAS_H / 2, 400, 250);

    // Main Chamber Body (Square-ish to fit both horizontally and vertically nicely)
    stroke(80);
    strokeWeight(2);
    fill(40, 45, 50); // Metallic dark grey
    rectMode(CENTER);
    rect(CANVAS_W / 2, CANVAS_H / 2, 440, 440, 20); // main body

    // Chamber internal cavity (viewport perspective)
    fill(15);
    stroke(60);
    ellipse(CANVAS_W / 2, CANVAS_H / 2, 400, 400);

    // Bottom Flange (Magnetron Housing)
    fill(50);
    ellipse(CANVAS_W / 2, CANVAS_H / 2 + 220, 260, 40); // outside edge
    fill(70);
    rect(CANVAS_W / 2, CANVAS_H / 2 + 240, 200, 60, 5); // housing box

    // The internal Target itself (This is what we zoom into)
    fill(100, 100, 100);
    stroke(150);
    ellipse(CANVAS_W / 2, CANVAS_H / 2 + 200, 120, 10);
    // Glow around target
    noStroke();
    fill(50, 150, 255, 100);
    ellipse(CANVAS_W / 2, CANVAS_H / 2 + 190, 140, 30);

    // Left Port (Gas Inlet)
    stroke(80);
    fill(60);
    rect(CANVAS_W / 2 - 220, CANVAS_H / 2, 40, 80);
    fill(30);
    rect(CANVAS_W / 2 - 240, CANVAS_H / 2, 80, 40);

    // Right Port (Vacuum Pump out)
    stroke(80);
    fill(60);
    rect(CANVAS_W / 2 + 220, CANVAS_H / 2, 40, 120);
    fill(50);
    quad(CANVAS_W / 2 + 240, CANVAS_H / 2 - 60,
        CANVAS_W / 2 + 240, CANVAS_H / 2 + 60,
        CANVAS_W / 2 + 310, CANVAS_H / 2 + 80,
        CANVAS_W / 2 + 310, CANVAS_H / 2 - 80); // Turbo pump base

    // Top Flange (Substrate/Anode)
    stroke(80);
    fill(50);
    ellipse(CANVAS_W / 2, CANVAS_H / 2 - 220, 260, 40);

    pop(); // End Camera Transform

    // Cross-fade to simulation view at the very end of the zoom
    if (ease > 0.8) {
        let fadeAlpha = map(ease, 0.8, 1.0, 0, 255);

        // Draw the 2D simulation setup on top with increasing opacity
        push();
        stroke(150, fadeAlpha);
        strokeWeight(4);
        line(0, TARGET_Y, CANVAS_W, TARGET_Y);
        stroke(100, Math.min(fadeAlpha, 255));
        line(0, SUBSTRATE_Y, CANVAS_W, SUBSTRATE_Y);

        // Target glow blending in
        noStroke();
        fill(50, 150, 255, fadeAlpha * 0.4);
        ellipse(CANVAS_W / 2, TARGET_Y - 20, 450, 80);
        pop();
    }

    // Intro Text Overlays
    push();
    textAlign(CENTER, TOP);
    textStyle(BOLD);
    let p = STATE.introProgress;
    let alpha = 0;
    let msg = "";

    // Fade in and out different messages based on progress
    if (p < 0.3) {
        msg = "External Vacuum Chamber";
        // fade in 0-0.05, hold until 0.25, fade out by 0.3
        if (p < 0.05) alpha = map(p, 0, 0.05, 0, 255);
        else if (p > 0.25) alpha = map(p, 0.25, 0.3, 255, 0);
        else alpha = 255;
    } else if (p >= 0.3 && p < 0.7) {
        msg = "Internal Magnetron Setup";
        if (p < 0.35) alpha = map(p, 0.3, 0.35, 0, 255);
        else if (p > 0.65) alpha = map(p, 0.65, 0.7, 255, 0);
        else alpha = 255;
    } else if (p >= 0.7 && p < 0.95) {
        msg = "Atomic Process";
        if (p < 0.75) alpha = map(p, 0.7, 0.75, 0, 255);
        else if (p > 0.9) alpha = map(p, 0.9, 0.95, 255, 0);
        else alpha = 255;
    }

    if (alpha > 0) {
        fill(255, 255, 255, alpha);
        textSize(32);
        // Draw shadow for readability
        drawingContext.shadowBlur = 10;
        drawingContext.shadowColor = "black";
        text(msg, CANVAS_W / 2, 40);
        drawingContext.shadowBlur = 0; // reset
    }
    pop();
}

// ----------------- CSV EXPORT -----------------

function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    if (text.includes(',') || text.includes('"') || text.includes('\n')) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function downloadCSV(filename, rows) {
    const csvText = rows.map(row => row.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function getRunTimestamp() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function buildSummaryCSVRows() {
    const totalDeposited = updateCompositionState();
    const activeSources = getActiveSources();
    const lambdaCm = computeMeanFreePathMeters() * 100;
    const metrics = STATE.lastUniformityMetrics || { nonUniformityPercent: 0, uniformityPercent: 100, centerThicknessNm: 0, edgeThicknessNm: 0, avgThicknessNm: 0 };
    const diagnostics = STATE.lastProcessDiagnostics || { scatteringRatio: 0, transportCode: 'BALLISTIC', uniformityCode: 'EXCELLENT', statusText: 'STABLE PROCESS' };
    const efficiency = STATE.effectiveDepositionRate / Math.max(1, getTotalActivePower());
    const rows = [
        ['Section', 'Metric', 'Value'],
        ['Run', 'Export timestamp', new Date().toISOString()],
        ['Run', 'Process time (s)', timeSec],
        ['Run', 'Active guns', activeSources.length ? activeSources.map((src, idx) => `Gun ${STATE.sources.indexOf(src) + 1}`).join(' + ') : 'None'],
        ['Run', 'Active materials', activeSources.length ? activeSources.map(src => src.material).join(' + ') : 'None'],
        ['Run', 'Power modes', activeSources.length ? activeSources.map(src => src.powerType).join(' / ') : 'None'],
        ['Run', 'Growth mode', STATE.growthMode],
        ['Settings', 'Total power (W)', getTotalActivePower()],
        ['Settings', 'Pressure (mTorr)', STATE.pressure],
        ['Settings', 'Working gas Ar (%)', STATE.argonPercent],
        ['Settings', 'Reactive gas O2 in Ar (%)', STATE.oxygenPercent],
        ['Settings', 'Temperature (K)', STATE.temperature],
        ['Settings', 'Magnetic field (T)', STATE.magField],
        ['Settings', 'Target-substrate distance (cm)', STATE.distanceCM],
        ['Settings', 'Target diameter (in)', STATE.targetDiaInches],
        ['Settings', 'Substrate diameter (in)', STATE.subDiaInches],
        ['Physics', 'Mean free path (cm)', lambdaCm.toFixed(3)],
        ['Physics', 'Scattering ratio d/lambda', diagnostics.scatteringRatio.toFixed(3)],
        ['Physics', 'Transport regime', getTransportDisplayLabel(diagnostics.transportCode)],
        ['Physics', 'Representative discharge voltage (V)', STATE.representativeVoltage.toFixed(2)],
        ['Physics', 'Total discharge current (A)', STATE.totalCurrent.toFixed(3)],
        ['Physics', 'Representative ion energy (eV)', STATE.representativeIonEnergy.toFixed(2)],
        ['Physics', 'Sputtering yield (atoms/ion)', STATE.yieldDisplay.toFixed(3)],
        ['Physics', 'Illustrative effective yield', STATE.illustrativeYield.toFixed(3)],
        ['Physics', 'Transport factor', STATE.transportFactor.toFixed(3)],
        ['Physics', 'Average sticking coefficient', STATE.stickingCoeff.toFixed(3)],
        ['Physics', 'Reactive hysteresis state', STATE.reactiveState.hysteresis.toFixed(3)],
        ['Outcome', 'Total deposited atoms', STATE.totalDeposited],
        ['Outcome', 'Deposition rate (atoms/s)', STATE.effectiveDepositionRate.toFixed(2)],
        ['Outcome', 'Average thickness (nm)', metrics.avgThicknessNm.toFixed(3)],
        ['Outcome', 'Center thickness (nm)', metrics.centerThicknessNm.toFixed(3)],
        ['Outcome', 'Edge thickness (nm)', metrics.edgeThicknessNm.toFixed(3)],
        ['Outcome', 'Non-uniformity (%)', metrics.nonUniformityPercent.toFixed(2)],
        ['Outcome', 'Uniformity (%)', (metrics.uniformityPercent === null ? 'Calculating...' : metrics.uniformityPercent.toFixed(2))],
        ['Outcome', 'Uniformity class', getUniformityDisplayLabel(diagnostics.uniformityCode)],
        ['Outcome', 'Center-to-edge ratio', (STATE.landingDiagnostics.centerEdgeRatio || 0).toFixed(3)],
        ['Outcome', 'Edge landing fraction (%)', ((STATE.landingDiagnostics.edgeFraction || 0) * 100).toFixed(2)],
        ['Outcome', 'Efficiency (atoms/W)', efficiency.toFixed(3)],
        ['Outcome', 'Process status', diagnostics.statusText]
    ];

    rows.push([]);
    rows.push(['Gun', 'Active', 'Material', 'Power (W)', 'Mode', 'Yield (atoms/ion)', 'Poisoning state']);
    STATE.sources.forEach((src, idx) => {
        rows.push([
            `Gun ${idx + 1}`,
            src.active ? 'Yes' : 'No',
            src.material,
            src.power,
            src.powerType,
            (src.yield * ({
                'Cu': 525, 'Al': 303, 'Ti': 295, 'Zn': 174,
                'Sn': 260, 'W': 344, 'Ta': 216, 'Mo': 369
            }[src.material] || 525)).toFixed(3),
            (STATE.reactiveState.poisoning[idx] || 0).toFixed(3)
        ]);
    });

    rows.push([]);
    rows.push(['Film composition', 'Estimated share (%)']);
    if (totalDeposited > 0) {
        Object.entries(STATE.filmComposition).forEach(([mat, amount]) => {
            rows.push([mat, ((amount / totalDeposited) * 100).toFixed(2)]);
        });
    } else {
        rows.push(['None', '0.00']);
    }

    return rows;
}

function buildTimeSeriesCSVRows() {
    const rows = [[
        'Time (s)', 'Total power (W)', 'Pressure (mTorr)', 'Working gas Ar (%)', 'Reactive gas O2 in Ar (%)', 'Temperature (K)', 'Magnetic field (T)',
        'Distance (cm)', 'Target dia (in)', 'Substrate dia (in)', 'Active guns', 'Modes',
        'Rate (atoms/s)', 'Total deposited atoms', 'Yield (atoms/ion)', 'Illustrative yield',
        'Mean free path (cm)', 'Scattering ratio', 'Transport regime', 'Voltage (V)', 'Current (A)',
        'Ion energy (eV)', 'Transport factor', 'Sticking coefficient', 'Reactive hysteresis',
        'Poisoning gun1', 'Poisoning gun2', 'Poisoning gun3',
        'Center thickness (nm)', 'Edge thickness (nm)', 'Average thickness (nm)',
        'Non-uniformity (%)', 'Uniformity (%)', 'Uniformity class',
        'Center-edge ratio', 'Edge landing fraction (%)', 'Film mix', 'Process status', 'Efficiency (atoms/W)'
    ]];

    STATE.exportHistory.forEach(row => {
        rows.push([
            row.timeSec,
            row.totalPowerW,
            row.pressuremTorr,
            row.argonPercent,
            row.oxygenPercent,
            row.temperatureK,
            row.magneticFieldT,
            row.distanceCm,
            row.targetDiaIn,
            row.substrateDiaIn,
            row.activeGuns,
            row.modes,
            row.depositionRateAtomsPerS.toFixed(2),
            row.totalDepositedAtoms,
            row.sputteringYield.toFixed(3),
            row.illustrativeYield.toFixed(3),
            row.meanFreePathCm.toFixed(3),
            row.scatteringRatio.toFixed(3),
            row.transportRegime,
            row.representativeVoltageV.toFixed(2),
            row.totalCurrentA.toFixed(3),
            row.ionEnergyEV.toFixed(2),
            row.transportFactor.toFixed(3),
            row.stickingCoeff.toFixed(3),
            row.reactiveHysteresis.toFixed(3),
            row.poisoningGun1.toFixed(3),
            row.poisoningGun2.toFixed(3),
            row.poisoningGun3.toFixed(3),
            row.centerThicknessNm.toFixed(3),
            row.edgeThicknessNm.toFixed(3),
            row.avgThicknessNm.toFixed(3),
            row.nonUniformityPercent.toFixed(2),
            row.uniformityPercent === null ? 'Calculating...' : row.uniformityPercent.toFixed(2),
            row.uniformityClass,
            row.centerEdgeRatio.toFixed(3),
            (row.edgeLandingFraction * 100).toFixed(2),
            row.filmMix,
            row.processStatus,
            row.efficiencyAtomsPerW.toFixed(3)
        ]);
    });

    return rows;
}

function buildProfileCSVRows() {
    const metrics = getUniformityMetrics();
    const thicknessData = movingAverage(metrics.rawThickness, 3);
    const subWidthPx = STATE.subDiaInches * (300 / 4);
    const subRadiusPx = subWidthPx / 2;
    const rows = [[
        'Bin index', 'Radial position (px from center)', 'Normalized radius (r/R)', 'In substrate area',
        'Thickness (nm)', 'Normalized thickness'
    ]];
    const maxThickness = Math.max(0.001, ...thicknessData);

    for (let i = 0; i < NUM_BINS; i++) {
        const posPx = (i * BIN_SIZE) - (CANVAS_W / 2);
        const normalizedRadius = subRadiusPx > 0 ? Math.abs(posPx) / subRadiusPx : 0;
        const inSubstrate = Math.abs(posPx) <= subRadiusPx;
        rows.push([
            i,
            posPx.toFixed(1),
            normalizedRadius.toFixed(3),
            inSubstrate ? 'Yes' : 'No',
            thicknessData[i].toFixed(3),
            (thicknessData[i] / maxThickness).toFixed(4)
        ]);
    }

    return rows;
}

function exportCSV() {
    const stamp = getRunTimestamp();
    downloadCSV(`sputtering_summary_${stamp}.csv`, buildSummaryCSVRows());
    setTimeout(() => downloadCSV(`sputtering_timeseries_${stamp}.csv`, buildTimeSeriesCSVRows()), 150);
    setTimeout(() => downloadCSV(`sputtering_profile_${stamp}.csv`, buildProfileCSVRows()), 300);
}


// ==========================================
// LIGHT / DARK MODE TOGGLE
// ==========================================
function initTheme() {
    const savedTheme = localStorage.getItem('sputter_theme');
    if (savedTheme === 'light') {
        document.body.classList.add('light-mode');
    }

    // Check elements
    const themeToggleBtn = document.getElementById('theme-toggle');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const isLight = document.body.classList.toggle('light-mode');
            localStorage.setItem('sputter_theme', isLight ? 'light' : 'dark');
            updateChartTheme(isLight);
        });
    }
}

function updateChartTheme(isLight) {
    let textColor = isLight ? '#546e7a' : '#6a96bb';
    let gridColor = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)';
    let titleColor = isLight ? '#212121' : '#ddeeff';

    if (typeof depChart !== 'undefined' && depChart && depChart.options) {
        if (depChart.options.scales.x) {
            depChart.options.scales.x.ticks.color = textColor;
            depChart.options.scales.x.grid.color = gridColor;
        }
        if (depChart.options.scales.y) {
            depChart.options.scales.y.ticks.color = textColor;
            depChart.options.scales.y.grid.color = gridColor;
        }
        if (depChart.options.scales.y1) {
            depChart.options.scales.y1.ticks.color = textColor;
            depChart.options.scales.y1.grid.color = gridColor;
        }
        depChart.update();
    }
    if (typeof profileChart !== 'undefined' && profileChart && profileChart.options) {
        if (profileChart.options.scales.x) {
            profileChart.options.scales.x.ticks.color = textColor;
            profileChart.options.scales.x.grid.color = gridColor;
        }
        if (profileChart.options.scales.y) {
            profileChart.options.scales.y.ticks.color = textColor;
            profileChart.options.scales.y.grid.color = gridColor;
        }
        profileChart.update();
    }
}

// Call init components after window load
window.addEventListener('load', () => {
    initTheme();

    // initialize colors based on current mode
    if (document.body.classList.contains('light-mode')) {
        setTimeout(() => updateChartTheme(true), 500); // wait mapping
    }
});


// ==========================================
// 3D TARGET VIEW RENDERING
// ==========================================
function drawTarget3D() {
    let matColor = MATERIALS[STATE.material].color;
    let mr = matColor[0], mg = matColor[1], mb = matColor[2];

    // 3D isometric perspective: project the cylindrical target from below
    let baseY = TARGET_Y + 40;
    let centerX = CANVAS_W / 2;
    let targetR = STATE.targetDiaInches * (60 / 3); // radius pixels

    // Use the original staggered 3-gun triangular arrangement so the active
    // source layout reads like the earlier simulator view.
    let spacing = targetR * 2.5;
    let allSlotPos = [
        { x: centerX, y: baseY - spacing * 0.3 },
        { x: centerX - spacing * 0.6, y: baseY + spacing * 0.15 },
        { x: centerX + spacing * 0.6, y: baseY + spacing * 0.15 }
    ];
    const useGunPos = (idx) => {
        const x = STATE.gunPositions && Number.isFinite(STATE.gunPositions[idx]) ? STATE.gunPositions[idx] : null;
        if (x === null) return null;
        const leftBound = CHAMBER_ML + WALL_W + 20;
        const rightBound = CANVAS_W - CHAMBER_MR - WALL_W - 20;
        return (x >= leftBound && x <= rightBound) ? x : null;
    };
    const gx0 = useGunPos(0);
    const gx1 = useGunPos(1);
    const gx2 = useGunPos(2);
    if (gx0 !== null) allSlotPos[0].x = gx0;
    if (gx1 !== null) allSlotPos[1].x = gx1;
    if (gx2 !== null) allSlotPos[2].x = gx2;

    for (let s = 0; s < 3; s++) {
        let src = STATE.sources[s];
        let gunActive = src && src.active;
        let gunPower = src ? src.power : 0;
        // Always draw the cold target body; gate glows on power
        let gunOn = gunActive && gunPower >= 80;
        let gunMatColor = (src && MATERIALS[src.material]) ? MATERIALS[src.material].color : matColor;
        let gmr = gunMatColor[0], gmg = gunMatColor[1], gmb = gunMatColor[2];

        let sx = allSlotPos[s].x;
        let sy = allSlotPos[s].y;
        let pulse = sin(millis() * 0.007 + s * 2.1) * 0.1 + 0.9;
        let throb = sin(millis() * 0.012 + s * 1.3) * 0.08 + 0.92;
        let pAlpha = gunOn ? constrain(map(gunPower, 80, 500, 0.3, 1.0), 0.3, 1.0) : 0;

        push();
        translate(sx, sy);

        // â”€â”€ 3D CYLINDRICAL BODY (always drawn, cold when gun off) â”€â”€
        let cylinderH = 36;
        let ellipseH = targetR * 0.45;
        let cylTopY = -cylinderH;
        noStroke();

        const bodyAlpha = gunOn ? 235 : 132;
        const topAlpha = gunOn ? 240 : 148;
        const ringAlpha = gunOn ? 1.0 : 0.22;

        // Cylinder face trapezoid â€” use per-gun material colour
        fill(gmr * 0.18, gmg * 0.18, gmb * 0.18, bodyAlpha);
        quad(
            -targetR, cylTopY,
            -targetR, 0,
            -targetR * 0.92, ellipseH * 0.5,
            -targetR * 0.92, cylTopY + ellipseH * 0.5
        );
        fill(gmr * 0.3, gmg * 0.3, gmb * 0.3, bodyAlpha - 12);
        quad(
            targetR * 0.92, cylTopY + ellipseH * 0.5,
            targetR * 0.92, ellipseH * 0.5,
            targetR, 0,
            targetR, cylTopY
        );

        drawingContext.shadowBlur = 12;
        drawingContext.shadowColor = gunOn ? `rgba(${gmr},${Math.round(gmg * 0.3)},30,0.4)` : 'rgba(0,0,0,0.18)';
        fill(gmr * 0.22, gmg * 0.22, gmb * 0.22, bodyAlpha);
        rectMode(CENTER);
        rect(0, -cylinderH * 0.5, targetR * 2, cylinderH, 2);
        drawingContext.shadowBlur = 0;

        fill(gmr * 0.15, gmg * 0.15, gmb * 0.15, gunOn ? 255 : 138);
        ellipse(0, 0, targetR * 2, ellipseH);

        // Top face
        fill(gmr * 0.35, gmg * 0.35, gmb * 0.35, topAlpha);
        ellipse(0, cylTopY, targetR * 2, ellipseH);
        fill(gmr * 0.55, gmg * 0.55, gmb * 0.55, gunOn ? 180 : 98);
        ellipse(0, cylTopY - 1, targetR * 1.8, ellipseH * 0.85);

        // â”€â”€ EROSION ZONE racetrack (only when gun >= 80W) â”€â”€
        if (gunOn) {
            let raceAlpha3D = constrain(map(gunPower, 80, 500, 0.4, 1.0), 0.4, 1.0);
            let erosionR = targetR * 0.68;
            drawingContext.shadowBlur = 18;
            drawingContext.shadowColor = `rgba(${gmr},60,20,0.9)`;
            stroke(255, 80 + sin(millis() * 0.01 + s) * 25, 20, 160 * pulse * raceAlpha3D);
            strokeWeight(4.5);
            noFill();
            ellipse(0, cylTopY, erosionR * 2, ellipseH * 0.65);
            strokeWeight(2.5);
            stroke(255, 140, 40, 90 * pulse * raceAlpha3D);
            ellipse(0, cylTopY, erosionR * 1.35, ellipseH * 0.44);
            drawingContext.shadowBlur = 0;
        }

        // â”€â”€ MAGNETRON RINGS (glowing blue concentric ovals) â”€â”€
        for (let ring = 0; ring < 3; ring++) {
            let rr = (targetR * 0.3) * (0.7 + ring * 0.35);
            let a = sin(millis() * 0.006 + ring * 1.2 + s * 2) * 20 + 45;
            drawingContext.shadowBlur = 7;
            drawingContext.shadowColor = `rgba(${mr},${Math.round(mg * 0.4)},255,0.5)`;
            stroke(mr * 0.6, mg * 0.3, 255, a * throb * ringAlpha);
            strokeWeight(ring === 1 ? 2 : 1);
            noFill();
            ellipse(0, cylTopY, rr * 2, ellipseH * (0.45 + ring * 0.06));
        }
        drawingContext.shadowBlur = 0;

        // â”€â”€ HOT CENTER SPOT (only when gun active) â”€â”€
        let hotA = gunOn ? (120 + sin(millis() * 0.015 + s) * 40) : 0;
        fill(255, 245, 180, hotA * (gunPower / 300) * pulse * pAlpha);
        noStroke();
        ellipse(0, cylTopY - 1, targetR * 0.35, ellipseH * 0.22);

        // â”€â”€ SUBSTRATE-FACING PLASMA PLUME (only when gun >= 80W) â”€â”€
        if (gunOn) {
            let plumeH = 50 + (gunPower / 8);
            let plumeW = targetR * 1.2;
            drawingContext.shadowBlur = 16;
            drawingContext.shadowColor = 'rgba(200,130,255,0.5)';
            fill(180, 80, 255, 35 * pulse * pAlpha);
            ellipse(0, cylTopY - plumeH * 0.4, plumeW * 1.1, plumeH);
            fill(210, 120, 255, 55 * pulse * pAlpha);
            ellipse(0, cylTopY - plumeH * 0.3, plumeW * 0.7, plumeH * 0.65);
            fill(255, 220, 255, 80 * pulse * pAlpha);
            ellipse(0, cylTopY - 8, plumeW * 0.35, plumeH * 0.28);
            drawingContext.shadowBlur = 0;
        }

        // Educational magnet annotation beneath each 3D cathode: N S N
        let magBaseY = ellipseH * 0.78;
        let magSpacing = targetR * 0.28;

        push();
        textAlign(CENTER, CENTER);
        noStroke();
        textSize(8);
        fill(255, 220, 220, 92);
        text('N', -magSpacing, magBaseY);
        text('N', magSpacing, magBaseY);
        fill(210, 225, 255, 96);
        text('S', 0, magBaseY);
        pop();

        pop();
    }

    // â”€â”€ SUBSTRATE (same style as 1D view) â”€â”€
    let subWidthPx3D = STATE.subDiaInches * (300 / 4);

    // Substrate slab
    push();
    translate(centerX, SUBSTRATE_Y - 18);
    drawSubstrateHolder(subWidthPx3D);
    drawThinFilmCoating(subWidthPx3D);
    pop();
}


