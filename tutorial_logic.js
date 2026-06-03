
// ----------------- TUTORIAL SEQUENCE -----------------

function startTutorial() {
    STATE.mode = 'tutorial';
    STATE.tutorialStep = 1;
    STATE.paused = true; // Pause while teaching
    document.getElementById('tutorial-overlay').classList.remove('hidden');

    // Reset sliders to default for tutorial

    STATE.pressure = 15;
    document.getElementById('pressureSlider').value = 15;
    document.getElementById('pressureVal').innerText = "15";

    STATE.magField = 0.03;
    document.getElementById('magSlider').value = 0.03;
    document.getElementById('magVal').innerText = "0.03";

    updateStaticYield();
    applyTutorialStep();
}

function nextTutorialStep() {
    STATE.tutorialStep++;
    applyTutorialStep();
}

function applyTutorialStep() {
    let titleEl = document.getElementById('tut-title');
    let textEl = document.getElementById('tut-text');
    let btnEl = document.getElementById('btn-tut-next');

    const dict = window.TRANSLATIONS[window.currentLang] || window.TRANSLATIONS['en'];

    // Clear all highlights
    document.getElementById('src1PowerSlider').classList.remove('highlight-control');
    document.getElementById('gun-card-1').classList.remove('highlight');
    document.getElementById('ctrl-pressure').classList.remove('highlight');
    document.getElementById('ctrl-mag').classList.remove('highlight');

    if (STATE.tutorialStep === 1) {
        titleEl.innerText = dict['tut-step1-title'];
        textEl.innerText = dict['tut-step1-text'];
        document.getElementById('src1PowerSlider').classList.add('highlight-control');
        document.getElementById('gun-card-1').classList.add('highlight');
        btnEl.innerText = dict['tut-next'];
    }
    else if (STATE.tutorialStep === 2) {
        titleEl.innerText = dict['tut-step2-title'];
        textEl.innerText = dict['tut-step2-text'];
        document.getElementById('ctrl-pressure').classList.add('highlight');
        btnEl.innerText = dict['tut-next'];
    }
    else if (STATE.tutorialStep === 3) {
        titleEl.innerText = dict['tut-step3-title'];
        textEl.innerText = dict['tut-step3-text'];
        document.getElementById('ctrl-mag').classList.add('highlight');
        btnEl.innerText = dict['tut-finish'];
    }
    else if (STATE.tutorialStep > 3) {
        // End Tutorial
        document.getElementById('tutorial-overlay').classList.add('hidden');
        STATE.mode = 'simulation';
        STATE.paused = false; // Resume
        btnEl.innerText = dict['tut-next'];
    }
}
