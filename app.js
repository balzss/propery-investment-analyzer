// --- HTML Escaping Helper (XSS prevention) ---
const escapeHTML = (str) => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
};

// --- Input Validation ---
const validateProperty = (fields) => {
    const errors = [];
    if (fields.price <= 0) errors.push('Price must be positive');
    if (fields.downPaymentPercent < 0 || fields.downPaymentPercent > 100) errors.push('Down payment must be 0–100%');
    if (fields.rate < 0) errors.push('Interest rate cannot be negative');
    if (fields.term < 1) errors.push('Loan term must be at least 1 year');
    if (fields.rent < 0) errors.push('Rent cannot be negative');
    return errors;
};

// --- Application State ---
let properties = [];
let valueChartInstance = null;
let roiChartInstance = null;
let roiValueChartInstance = null;
let equityChartInstance = null;
let propertyIdToDelete = null;

let isSharedView = false;

// --- Global Settings ---
const defaultSettings = { taxRate: 4, lawyerRate: 0.5, inflation: 3.5 };
let settings = { ...defaultSettings };

const loadSettings = () => {
    const stored = localStorage.getItem('property_calculator_settings');
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            settings = { ...defaultSettings, ...parsed };
        } catch (e) {
            console.error("Error parsing settings", e);
            settings = { ...defaultSettings };
        }
    } else {
        settings = { ...defaultSettings };
    }
};

const saveSettings = () => {
    if (isSharedView) return;
    localStorage.setItem('property_calculator_settings', JSON.stringify(settings));
};

// --- User Preferences (local-only, not shared) ---
const defaultPreferences = { theme: 'light', language: 'en', currency: 'huf', chartYears: 20 };
let preferences = { ...defaultPreferences };

const loadPreferences = () => {
    const stored = localStorage.getItem('property_calculator_preferences');
    if (stored) {
        try {
            preferences = { ...defaultPreferences, ...JSON.parse(stored) };
        } catch (e) {
            preferences = { ...defaultPreferences };
        }
    } else {
        preferences = { ...defaultPreferences };
    }
};

const savePreferences = () => {
    localStorage.setItem('property_calculator_preferences', JSON.stringify(preferences));
};

// --- Local Storage Helper ---
const saveProperties = () => {
    if (isSharedView) return;
    localStorage.setItem('property_calculator_data', JSON.stringify(properties));
};

// --- Formatters ---
const formatHUF = (num) => {
    return new Intl.NumberFormat('hu-HU', {
        style: 'currency',
        currency: 'HUF',
        maximumFractionDigits: 0
    }).format(num);
};

const formatCompact = (num) => {
    return new Intl.NumberFormat('hu-HU', {
        notation: "compact",
        compactDisplay: "short",
        maximumFractionDigits: 2
    }).format(num);
}

// --- Calculations ---
const calculateMortgage = (principal, annualRate, years) => {
    if (principal <= 0) return 0;
    const monthlyRate = annualRate / 100 / 12;
    const numberOfPayments = years * 12;

    if (monthlyRate === 0) return principal / numberOfPayments;

    const x = Math.pow(1 + monthlyRate, numberOfPayments);
    const monthlyPayment = principal * ((monthlyRate * x) / (x - 1));
    return monthlyPayment;
};

const getRemainingBalance = (principal, annualRate, termYears, year) => {
    const r = annualRate / 100 / 12;
    const n = termYears * 12;
    const p = year * 12;

    if (p >= n) return 0;
    if (r === 0) return principal - (principal/n)*p;

    // Formula for remaining balance
    const numerator = Math.pow(1 + r, n) - Math.pow(1 + r, p);
    const denominator = Math.pow(1 + r, n) - 1;

    return principal * (numerator / denominator);
};

const calculateProjectedROI = (prop, targetYear) => {
    if (prop.totalInvested <= 0) return 0;

    let currentPrice = prop.afterRenoValue || prop.price;
    let accumulatedCashflow = 0;
    const annualMortgage = prop.monthlyPayment * 12;
    const inflationRate = settings.inflation / 100;
    const monthlyCosts = prop.monthlyCosts || 0;

    for (let i = 1; i <= targetYear; i++) {
        // Update Price (Assuming price grows at inflation rate)
        currentPrice = currentPrice * (1 + inflationRate);

        // Update Cashflow (Rent and costs grow with inflation)
        const yearlyRent = (prop.rent * 12) * Math.pow(1 + inflationRate, i - 1);
        const yearlyCosts = (monthlyCosts * 12) * Math.pow(1 + inflationRate, i - 1);
        const yearlyCashflow = yearlyRent - annualMortgage - yearlyCosts;
        accumulatedCashflow += yearlyCashflow;
    }

    const remainingLoan = getRemainingBalance(prop.loanAmount, prop.rate, prop.term, targetYear);
    const equity = currentPrice - remainingLoan;

    // Total Position = Equity + accumulated cashflow
    const totalPosition = equity + accumulatedCashflow;

    // Profit = Position - Initial Investment
    const profit = totalPosition - prop.totalInvested;

    return (profit / prop.totalInvested) * 100;
};

const calculateProjectedProfit = (prop, targetYear) => {
    if (prop.totalInvested <= 0) return 0;

    let currentPrice = prop.afterRenoValue || prop.price;
    let accumulatedCashflow = 0;
    const annualMortgage = prop.monthlyPayment * 12;
    const inflationRate = settings.inflation / 100;
    const monthlyCosts = prop.monthlyCosts || 0;

    for (let i = 1; i <= targetYear; i++) {
        currentPrice = currentPrice * (1 + inflationRate);
        const yearlyRent = (prop.rent * 12) * Math.pow(1 + inflationRate, i - 1);
        const yearlyCosts = (monthlyCosts * 12) * Math.pow(1 + inflationRate, i - 1);
        accumulatedCashflow += yearlyRent - annualMortgage - yearlyCosts;
    }

    const remainingLoan = getRemainingBalance(prop.loanAmount, prop.rate, prop.term, targetYear);
    const equity = currentPrice - remainingLoan;
    return (equity + accumulatedCashflow) - prop.totalInvested;
};

const recalculateProperty = (prop) => {
    const price = prop.price;
    const rent = prop.rent;
    const downPaymentPercent = prop.downPaymentPercent;
    const renoCost = prop.renoCost;
    const rate = prop.rate;
    const term = prop.term;

    // Default new fields for backwards compatibility
    if (!prop.afterRenoValue) prop.afterRenoValue = price;
    if (!prop.monthlyCosts) prop.monthlyCosts = 0;

    // Fees
    const tax = price * (settings.taxRate / 100);
    const lawyer = price * (settings.lawyerRate / 100);
    const downPayment = price * (downPaymentPercent / 100);

    // Total Initial Investment
    const totalInvested = downPayment + renoCost + tax + lawyer;

    const loanAmount = price - downPayment;
    const monthlyPayment = calculateMortgage(loanAmount, rate, term);
    const cashflow = rent - monthlyPayment - prop.monthlyCosts;

    // Update prop object
    prop.downPayment = downPayment;
    prop.totalInvested = totalInvested;
    prop.loanAmount = loanAmount;
    prop.monthlyPayment = monthlyPayment;
    prop.cashflow = cashflow;

    return prop;
};


// --- DOM Elements ---
const form = document.getElementById('propertyForm');
const tableBody = document.getElementById('resultsTableBody');
const resultsSection = document.getElementById('results-section');
const chartsContainer = document.getElementById('charts-container');
const emptyState = document.getElementById('empty-state');
const tooltip = document.getElementById('global-tooltip');
const deleteModal = document.getElementById('delete-modal');
const deletePropNameEl = document.getElementById('delete-property-name');
const formErrors = document.getElementById('formErrors');
const benchmarkRateInput = document.getElementById('benchmarkRate');

// Real-time calculation elements (Sidebar)
const pValueInput = document.getElementById('pValue');
const pDownPercentInput = document.getElementById('pDownPercent');
const pDownValueInput = document.getElementById('pDownValue');
const pRenoInput = document.getElementById('pReno');
const downPaymentDisplay = document.getElementById('downPaymentDisplay');
const initialCashInfo = document.getElementById('initialCashInfo');

// --- Sidebar Helper ---
const updateDownPaymentDisplay = () => {
    const priceMillions = parseFloat(pValueInput.value) || 0;
    const percent = parseFloat(pDownPercentInput.value) || 0;
    const renoMillions = parseFloat(pRenoInput.value) || 0;

    if (priceMillions > 0) {
        initialCashInfo.classList.remove('hidden');
        const actualPrice = priceMillions * 1000000;
        const renoCost = renoMillions * 1000000;
        const downPaymentValue = actualPrice * (percent / 100);
        const tax = actualPrice * (settings.taxRate / 100);
        const lawyer = actualPrice * (settings.lawyerRate / 100);
        const totalCash = downPaymentValue + renoCost + tax + lawyer;
        downPaymentDisplay.textContent = `Total Cash Needed: ${formatHUF(totalCash)}`;
        const feeLabel = document.getElementById('initialCashFeeLabel');
        if (feeLabel) feeLabel.textContent = `Tax (${settings.taxRate}%) + Lawyer (${settings.lawyerRate}%)`;
    } else {
        initialCashInfo.classList.add('hidden');
        downPaymentDisplay.textContent = 'Total Cash Needed: 0 Ft';
    }
};

// Sync down payment % → value
const syncDownFromPercent = () => {
    const priceM = parseFloat(pValueInput.value) || 0;
    const pct = parseFloat(pDownPercentInput.value) || 0;
    if (priceM > 0) {
        pDownValueInput.value = (priceM * pct / 100).toFixed(1).replace(/\.0$/, '');
    } else {
        pDownValueInput.value = '';
    }
    updateDownPaymentDisplay();
};

// Sync down payment value → %
const syncDownFromValue = () => {
    const priceM = parseFloat(pValueInput.value) || 0;
    const valM = parseFloat(pDownValueInput.value) || 0;
    if (priceM > 0) {
        pDownPercentInput.value = (valM / priceM * 100).toFixed(1).replace(/\.0$/, '');
    }
    updateDownPaymentDisplay();
};

pValueInput.addEventListener('input', syncDownFromPercent);
pDownPercentInput.addEventListener('input', syncDownFromPercent);
pDownValueInput.addEventListener('input', syncDownFromValue);
pRenoInput.addEventListener('input', updateDownPaymentDisplay);
benchmarkRateInput.addEventListener('input', () => {
    if (properties.length > 0) renderCharts();
});

// --- Form Submit ---
form.addEventListener('submit', (e) => {
    e.preventDefault();
    addProperty();
});

// --- Form Error Display ---
const showFormErrors = (errors) => {
    formErrors.innerHTML = errors.map(e => `<div>${escapeHTML(e)}</div>`).join('');
    formErrors.classList.remove('hidden');
};

const clearFormErrors = () => {
    formErrors.innerHTML = '';
    formErrors.classList.add('hidden');
};

// --- Logic ---
function addProperty() {
    if (isSharedView) return;
    clearFormErrors();

    const name = document.getElementById('pName').value;
    const priceMillions = parseFloat(document.getElementById('pValue').value);
    const downPaymentPercent = parseFloat(document.getElementById('pDownPercent').value);
    const renoMillions = parseFloat(document.getElementById('pReno').value) || 0;
    const afterRenoMillions = parseFloat(document.getElementById('pAfterRenoValue').value) || 0;
    const monthlyCostsThousands = parseFloat(document.getElementById('pMonthlyCosts').value) || 0;
    const rate = parseFloat(document.getElementById('pRate').value);
    const term = parseFloat(document.getElementById('pTerm').value);
    const rentThousands = parseFloat(document.getElementById('pRent').value);

    const price = priceMillions * 1000000;
    const rent = rentThousands * 1000;
    const renoCost = renoMillions * 1000000;
    const afterRenoValue = afterRenoMillions > 0 ? afterRenoMillions * 1000000 : price;
    const monthlyCosts = monthlyCostsThousands * 1000;

    // Validate
    const errors = validateProperty({ price, downPaymentPercent, rate, term, rent });
    if (errors.length > 0) {
        showFormErrors(errors);
        return;
    }

    let newProp = {
        id: Date.now(),
        name,
        price,
        rent,
        renoCost,
        afterRenoValue,
        monthlyCosts,
        downPaymentPercent,
        rate,
        term,
        isEditing: false
    };

    newProp = recalculateProperty(newProp);
    properties.push(newProp);
    saveProperties();
    updateUI();

    document.getElementById('pName').value = '';
    document.getElementById('pValue').value = '';
    document.getElementById('pRent').value = '';
    document.getElementById('pReno').value = '0';
    document.getElementById('pAfterRenoValue').value = '';
    document.getElementById('pMonthlyCosts').value = '0';
    updateDownPaymentDisplay();
}

// --- Tooltip Logic ---
window.showBreakdownTooltip = (e, id) => {
    const prop = properties.find(p => p.id === id);
    if(!prop) return;

    const tax = prop.price * (settings.taxRate / 100);
    const lawyer = prop.price * (settings.lawyerRate / 100);

    tooltip.innerHTML = `
        <div class="font-bold mb-2 border-b border-gray-600 pb-1 text-gray-200">Initial Cash Breakdown</div>
        <div class="space-y-1">
            <div class="flex justify-between">
                <span class="text-gray-400">Down Pmt:</span>
                <span>${formatCompact(prop.downPayment)}</span>
            </div>
            <div class="flex justify-between">
                <span class="text-gray-400">Renovation:</span>
                <span>${formatCompact(prop.renoCost)}</span>
            </div>
            <div class="flex justify-between">
                <span class="text-gray-400">Tax (${settings.taxRate}%):</span>
                <span>${formatCompact(tax)}</span>
            </div>
            <div class="flex justify-between">
                <span class="text-gray-400">Lawyer (${settings.lawyerRate}%):</span>
                <span>${formatCompact(lawyer)}</span>
            </div>
            <div class="mt-2 pt-1 border-t border-gray-600 flex justify-between font-bold text-indigo-300">
                <span>Total:</span>
                <span>${formatCompact(prop.totalInvested)}</span>
            </div>
        </div>
        <div class="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-800"></div>
    `;

    const rect = e.currentTarget.getBoundingClientRect();
    tooltip.style.left = `${rect.left + rect.width / 2}px`;
    tooltip.style.top = `${rect.top - 8}px`;
    tooltip.classList.remove('hidden');
}

window.hideBreakdownTooltip = () => {
    tooltip.classList.add('hidden');
}

// Sync down payment fields in table edit mode
window.syncTableDown = (id, source) => {
    const priceInput = document.getElementById(`input-price-${id}`);
    const downPercentInput = document.getElementById(`input-down-${id}`);
    const downValueInput = document.getElementById(`input-down-value-${id}`);
    if (!priceInput || !downPercentInput || !downValueInput) return;

    const priceM = parseFloat(priceInput.value) || 0;
    if (source === 'percent') {
        const pct = parseFloat(downPercentInput.value) || 0;
        if (priceM > 0) {
            downValueInput.value = (priceM * pct / 100).toFixed(1).replace(/\.0$/, '');
        }
    } else {
        const valM = parseFloat(downValueInput.value) || 0;
        if (priceM > 0) {
            downPercentInput.value = (valM / priceM * 100).toFixed(1).replace(/\.0$/, '');
        }
    }
};

window.toggleEdit = (id) => {
    if (isSharedView) return;
    const prop = properties.find(p => p.id === id);
    if (!prop) return;

    // If we are currently editing (meaning we clicked Save)
    if (prop.isEditing) {
        // Gather values from inputs
        const nameInput = document.getElementById(`input-name-${id}`);
        const priceInput = document.getElementById(`input-price-${id}`);
        const downInput = document.getElementById(`input-down-${id}`);
        const renoInput = document.getElementById(`input-reno-${id}`);
        const rateInput = document.getElementById(`input-rate-${id}`);
        const rentInput = document.getElementById(`input-rent-${id}`);
        const afterRenoInput = document.getElementById(`input-afterreno-${id}`);
        const costsInput = document.getElementById(`input-costs-${id}`);

        const newName = nameInput ? nameInput.value : prop.name;
        const newPrice = priceInput ? (parseFloat(priceInput.value) || 0) * 1000000 : prop.price;
        const newDown = downInput ? (parseFloat(downInput.value) || 0) : prop.downPaymentPercent;
        const newReno = renoInput ? (parseFloat(renoInput.value) || 0) * 1000000 : prop.renoCost;
        const newRate = rateInput ? (parseFloat(rateInput.value) || 0) : prop.rate;
        const newRent = rentInput ? (parseFloat(rentInput.value) || 0) * 1000 : prop.rent;
        const newAfterReno = afterRenoInput ? ((parseFloat(afterRenoInput.value) || 0) > 0 ? (parseFloat(afterRenoInput.value)) * 1000000 : newPrice) : prop.afterRenoValue;
        const newCosts = costsInput ? (parseFloat(costsInput.value) || 0) * 1000 : prop.monthlyCosts;

        // Validate before saving
        const errors = validateProperty({
            price: newPrice,
            downPaymentPercent: newDown,
            rate: newRate,
            term: prop.term,
            rent: newRent
        });
        if (errors.length > 0) {
            alert(errors.join('\n'));
            return;
        }

        prop.name = newName;
        prop.price = newPrice;
        prop.downPaymentPercent = newDown;
        prop.renoCost = newReno;
        prop.rate = newRate;
        prop.rent = newRent;
        prop.afterRenoValue = newAfterReno;
        prop.monthlyCosts = newCosts;

        // Recalculate and Save
        recalculateProperty(prop);
        saveProperties();

        // Apply toggle and perform a full refresh (including charts)
        prop.isEditing = false;
        updateUI();
    } else {
        // Enter edit mode
        prop.isEditing = true;
        // Only re-render the table, skipping chart destruction/re-creation
        renderTable();
    }
};

// --- Delete Property Workflow ---
window.removeProperty = (id) => {
    if (isSharedView) return;
    const prop = properties.find(p => p.id === id);
    if (!prop) return;

    propertyIdToDelete = id;
    deletePropNameEl.textContent = prop.name;
    deleteModal.classList.remove('hidden');
};

window.closeDeleteModal = () => {
    deleteModal.classList.add('hidden');
    propertyIdToDelete = null;
};

window.executeDelete = () => {
    if (propertyIdToDelete === null) return;

    properties = properties.filter(p => p.id !== propertyIdToDelete);
    saveProperties();
    updateUI();
    closeDeleteModal();
};

// --- Settings Drawer ---
const settingsDrawer = document.getElementById('settings-drawer');
const settingsBackdrop = document.getElementById('settings-backdrop');
const settingTaxInput = document.getElementById('settingTaxRate');
const settingLawyerInput = document.getElementById('settingLawyerRate');
const settingInflationInput = document.getElementById('settingInflation');

window.openSettings = () => {
    settingTaxInput.value = settings.taxRate;
    settingLawyerInput.value = settings.lawyerRate;
    settingInflationInput.value = settings.inflation;
    // Sync preference controls
    document.getElementById('prefTheme').value = preferences.theme;
    document.getElementById('prefLanguage').value = preferences.language;
    document.getElementById('prefCurrency').value = preferences.currency;
    settingsDrawer.classList.add('open');
    settingsBackdrop.classList.remove('hidden');
};

window.closeSettings = () => {
    settingsDrawer.classList.remove('open');
    settingsBackdrop.classList.add('hidden');
};

const onSettingsChange = () => {
    settings.taxRate = parseFloat(settingTaxInput.value) || defaultSettings.taxRate;
    settings.lawyerRate = parseFloat(settingLawyerInput.value) || defaultSettings.lawyerRate;
    settings.inflation = parseFloat(settingInflationInput.value) || defaultSettings.inflation;
    saveSettings();
    properties.forEach(recalculateProperty);
    saveProperties();
    updateUI();
    updateDownPaymentDisplay();
};

settingTaxInput.addEventListener('input', onSettingsChange);
settingLawyerInput.addEventListener('input', onSettingsChange);
settingInflationInput.addEventListener('input', onSettingsChange);

// --- Preference Controls ---
const onPreferenceChange = () => {
    preferences.theme = document.getElementById('prefTheme').value;
    preferences.language = document.getElementById('prefLanguage').value;
    preferences.currency = document.getElementById('prefCurrency').value;
    savePreferences();
    applyPreferencesUI();
    if (properties.length > 0) renderCharts();
};

document.getElementById('prefTheme').addEventListener('change', onPreferenceChange);
document.getElementById('prefLanguage').addEventListener('change', onPreferenceChange);
document.getElementById('prefCurrency').addEventListener('change', onPreferenceChange);

// Chart year range toggle
window.setChartYears = (years) => {
    preferences.chartYears = years;
    savePreferences();
    applyPreferencesUI();
    if (properties.length > 0) renderCharts();
};

const applyPreferencesUI = () => {
    // Apply theme
    document.documentElement.classList.toggle('dark', preferences.theme === 'dark');

    // Update chart year toggle buttons
    const activeClasses = ['bg-indigo-100', 'text-indigo-700', 'border-indigo-300', 'dark:bg-indigo-900/30', 'dark:text-indigo-300', 'dark:border-indigo-700'];
    const inactiveClasses = ['bg-white', 'dark:bg-zinc-800', 'text-gray-700', 'dark:text-zinc-300', 'hover:bg-gray-50', 'dark:hover:bg-zinc-700'];
    document.querySelectorAll('#chartYearToggle button').forEach(btn => {
        const y = parseInt(btn.dataset.years);
        if (y === preferences.chartYears) {
            btn.classList.add(...activeClasses);
            btn.classList.remove(...inactiveClasses);
        } else {
            btn.classList.remove(...activeClasses);
            btn.classList.add(...inactiveClasses);
        }
    });
    // Update chart titles
    document.querySelectorAll('[data-chart-title]').forEach(el => {
        const base = el.dataset.chartTitle;
        el.textContent = `${base} (${preferences.chartYears} Years)`;
    });
};

const isDark = () => preferences.theme === 'dark';

// --- Export / Import ---
window.exportData = () => {
    const exportObj = {
        settings,
        preferences,
        properties: properties.map(({ isEditing, ...rest }) => rest)
    };
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'property-calculator-export.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

window.importData = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.properties || !Array.isArray(data.properties)) {
                alert('Invalid file: missing properties array.');
                return;
            }
            if (data.settings) {
                settings = { ...defaultSettings, ...data.settings };
                saveSettings();
            }
            if (data.preferences) {
                preferences = { ...defaultPreferences, ...data.preferences };
                savePreferences();
                applyPreferencesUI();
            }
            properties = data.properties.map(p => {
                p.isEditing = false;
                return recalculateProperty(p);
            });
            saveProperties();
            updateUI();
            updateDownPaymentDisplay();
            alert('Data imported successfully.');
        } catch (err) {
            alert('Error importing data: ' + err.message);
        }
    };
    reader.readAsText(file);
    event.target.value = '';
};

// --- Share via URL ---
const encodeShareData = (s, props) => {
    const settingsPart = `${s.taxRate},${s.lawyerRate},${s.inflation}`;
    const propParts = props.map(p => {
        const name = encodeURIComponent(p.name);
        const priceM = p.price / 1000000;
        const rentK = p.rent / 1000;
        const renoM = p.renoCost / 1000000;
        const afterRenoM = (p.afterRenoValue || p.price) / 1000000;
        const costsK = (p.monthlyCosts || 0) / 1000;
        return `${name}|${priceM}|${rentK}|${renoM}|${p.downPaymentPercent}|${p.rate}|${p.term}|${afterRenoM}|${costsK}`;
    });
    const raw = [settingsPart, ...propParts].join(';');
    return btoa(unescape(encodeURIComponent(raw)));
};

const decodeShareData = (encoded) => {
    try {
        const raw = decodeURIComponent(escape(atob(encoded)));
        const parts = raw.split(';');
        if (parts.length < 1) return null;

        const settingsFields = parts[0].split(',');
        if (settingsFields.length !== 3) return null;
        const decoded = {
            settings: {
                taxRate: parseFloat(settingsFields[0]),
                lawyerRate: parseFloat(settingsFields[1]),
                inflation: parseFloat(settingsFields[2])
            },
            properties: []
        };

        for (let i = 1; i < parts.length; i++) {
            const fields = parts[i].split('|');
            if (fields.length < 7) return null;
            const price = parseFloat(fields[1]) * 1000000;
            decoded.properties.push({
                id: Date.now() + i,
                name: decodeURIComponent(fields[0]),
                price: price,
                rent: parseFloat(fields[2]) * 1000,
                renoCost: parseFloat(fields[3]) * 1000000,
                downPaymentPercent: parseFloat(fields[4]),
                rate: parseFloat(fields[5]),
                term: parseFloat(fields[6]),
                afterRenoValue: fields.length >= 8 ? parseFloat(fields[7]) * 1000000 : price,
                monthlyCosts: fields.length >= 9 ? parseFloat(fields[8]) * 1000 : 0,
                isEditing: false
            });
        }
        return decoded;
    } catch (e) {
        console.error('Error decoding shared data', e);
        return null;
    }
};

const showToast = (message) => {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.classList.add('hidden'), 300);
    }, 2000);
};

window.shareData = () => {
    if (properties.length === 0) {
        showToast('Add properties first');
        return;
    }
    const encoded = encodeShareData(settings, properties);
    const url = window.location.origin + window.location.pathname + '?s=' + encoded;
    navigator.clipboard.writeText(url).then(() => {
        showToast('Link copied to clipboard!');
    }).catch(() => {
        showToast('Failed to copy link');
    });
};

let sharedProperties = [];

const exitSharedView = () => {
    isSharedView = false;
    sharedProperties = [];
    window.history.replaceState({}, '', window.location.pathname);
    document.getElementById('shared-banner').classList.add('hidden');
    document.getElementById('previewWithMyData').checked = false;
};

const loadLocalProperties = () => {
    const storedData = localStorage.getItem('property_calculator_data');
    if (storedData) {
        try {
            const parsed = JSON.parse(storedData);
            parsed.forEach(p => { p.isEditing = false; recalculateProperty(p); });
            return parsed;
        } catch (e) {
            return [];
        }
    }
    return [];
};

window.replaceWithSharedData = () => {
    exitSharedView();
    localStorage.setItem('property_calculator_settings', JSON.stringify(settings));
    localStorage.setItem('property_calculator_data', JSON.stringify(properties.map(({ isEditing, ...rest }) => rest)));
    showToast('Shared data replaced your data');
};

window.addSharedData = () => {
    const localProps = loadLocalProperties();
    const merged = [...localProps, ...sharedProperties.map(p => ({ ...p, id: Date.now() + Math.random() }))];
    exitSharedView();
    loadSettings();
    properties = merged.map(p => recalculateProperty(p));
    localStorage.setItem('property_calculator_data', JSON.stringify(properties.map(({ isEditing, ...rest }) => rest)));
    updateUI();
    showToast('Shared properties added to your data');
};

window.dismissSharedData = () => {
    exitSharedView();
    loadSettings();
    properties = loadLocalProperties();
    updateUI();
};

window.togglePreviewMyData = () => {
    const checked = document.getElementById('previewWithMyData').checked;
    if (checked) {
        const localProps = loadLocalProperties();
        const tagged = sharedProperties.map(p => ({ ...p, _isShared: true }));
        properties = [...localProps, ...tagged];
        loadSettings();
        properties.forEach(p => recalculateProperty(p));
    } else {
        properties = sharedProperties.map(p => ({ ...p, _isShared: true }));
        properties.forEach(p => recalculateProperty(p));
    }
    updateUI();
};

function initApp() {
    loadSettings();
    loadPreferences();
    applyPreferencesUI();

    const shareParam = new URLSearchParams(window.location.search).get('s');
    if (shareParam) {
        const decoded = decodeShareData(shareParam);
        if (decoded) {
            isSharedView = true;
            settings = { ...defaultSettings, ...decoded.settings };
            settingTaxInput.value = settings.taxRate;
            settingLawyerInput.value = settings.lawyerRate;
            settingInflationInput.value = settings.inflation;
            sharedProperties = decoded.properties.map(p => { p._isShared = true; return recalculateProperty(p); });
            properties = sharedProperties.map(p => ({ ...p }));
            document.getElementById('shared-banner').classList.remove('hidden');
            updateUI();
            return;
        }
    }

    const storedData = localStorage.getItem('property_calculator_data');
    if (storedData) {
        try {
            properties = JSON.parse(storedData);
            properties.forEach(p => {
                p.isEditing = false;
                recalculateProperty(p);
            });
        } catch (e) {
            console.error("Error parsing local storage", e);
            properties = [];
        }
    } else {
        properties = [];
    }

    updateUI();
}

function updateUI() {
    // Disable form in shared view
    const formFieldset = form.querySelectorAll('input, button[type="submit"]');
    formFieldset.forEach(el => {
        el.disabled = isSharedView;
        if (isSharedView) el.classList.add('opacity-50');
        else el.classList.remove('opacity-50');
    });

    const chartYearToggleWrapper = document.getElementById('chartYearToggleWrapper');

    if (properties.length === 0) {
        emptyState.classList.remove('hidden');
        resultsSection.classList.add('hidden');
        chartsContainer.classList.add('hidden');
        chartYearToggleWrapper.classList.add('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    resultsSection.classList.remove('hidden');
    chartsContainer.classList.remove('hidden');
    chartYearToggleWrapper.classList.remove('hidden');

    renderTable();
    renderCharts();
}

function renderTable() {
    tableBody.innerHTML = '';
    properties.forEach(prop => {
        const tr = document.createElement('tr');
        if (prop._isShared) tr.classList.add('shared-row');
        const cfClass = prop.cashflow >= 0 ? 'text-green-600 font-bold' : 'text-red-600 font-bold';

        const priceM = (prop.price / 1000000).toFixed(1).replace(/\.0$/, '');
        const rentK = prop.rent / 1000;
        const renoM = (prop.renoCost / 1000000).toFixed(1).replace(/\.0$/, '');
        const afterRenoM = ((prop.afterRenoValue || prop.price) / 1000000).toFixed(1).replace(/\.0$/, '');
        const costsK = ((prop.monthlyCosts || 0) / 1000);

        const downM = (prop.downPayment / 1000000).toFixed(1).replace(/\.0$/, '');

        const roi5 = calculateProjectedROI(prop, 5);

        const roi5Class = roi5 >= 0 ? 'text-green-600' : 'text-red-600';

        const safeName = escapeHTML(prop.name);

        const commonCells = `
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">
                <div class="cursor-help border-b border-dotted border-gray-400 dark:border-zinc-500 inline-block pb-0.5"
                     onmouseenter="showBreakdownTooltip(event, ${prop.id})"
                     onmouseleave="hideBreakdownTooltip()"
                     onclick="showBreakdownTooltip(event, ${prop.id})">
                    <div id="ic-text-${prop.id}" class="font-medium text-gray-900 dark:text-zinc-100">${formatCompact(prop.totalInvested)}</div>
                    <div class="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">(${prop.downPaymentPercent}% + Fees)</div>
                </div>
                ${prop.isEditing ? `
                    <div class="mt-2 space-y-1 border-t pt-1 border-gray-200 dark:border-zinc-700">
                        <div class="text-xs text-gray-400 dark:text-zinc-500 flex items-center">
                            <input type="number" step="0.01" id="input-down-${prop.id}" class="table-input w-10 text-xs"
                                   value="${prop.downPaymentPercent}"
                                   oninput="syncTableDown(${prop.id}, 'percent')">
                            <span class="ml-1">%</span>
                        </div>
                        <div class="text-xs text-gray-400 dark:text-zinc-500 flex items-center">
                            <input type="number" step="0.1" id="input-down-value-${prop.id}" class="table-input w-14 text-xs"
                                   value="${downM}"
                                   oninput="syncTableDown(${prop.id}, 'value')">
                            <span class="ml-1">M Ft</span>
                        </div>
                        <div class="text-xs text-gray-400 dark:text-zinc-500 flex items-center">
                            <input type="number" step="0.1" id="input-reno-${prop.id}" class="table-input w-10 text-xs"
                                   value="${renoM}">
                            <span class="ml-1">M Reno</span>
                        </div>
                        <div class="text-xs text-gray-400 dark:text-zinc-500 flex items-center">
                            <input type="number" step="0.1" id="input-afterreno-${prop.id}" class="table-input w-14 text-xs"
                                   value="${afterRenoM}" placeholder="${priceM}">
                            <span class="ml-1">M Val</span>
                        </div>
                        <div class="text-xs text-gray-400 dark:text-zinc-500 flex items-center">
                            <input type="number" step="1" id="input-costs-${prop.id}" class="table-input w-14 text-xs"
                                   value="${costsK}">
                            <span class="ml-1">k Cost</span>
                        </div>
                    </div>
                ` : ''}
            </td>
        `;

        if (prop.isEditing) {
            tr.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-zinc-100">
                    <input type="text" id="input-name-${prop.id}" class="table-input font-bold"
                           value="${safeName}">
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">
                    <div class="flex items-center">
                        <input type="number" step="0.1" id="input-price-${prop.id}" class="table-input w-16"
                               value="${priceM}">
                        <span class="ml-1 text-xs">M</span>
                    </div>
                </td>
                ${commonCells}
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">
                    <div class="flex items-center">
                        <input type="number" step="0.01" id="input-rate-${prop.id}" class="table-input w-14"
                               value="${prop.rate}">
                        <span class="ml-1 text-xs">%</span>
                    </div>
                </td>
                <td id="mortgage-${prop.id}" class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">${formatHUF(prop.monthlyPayment)}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">
                    <div class="flex items-center">
                        <input type="number" id="input-rent-${prop.id}" class="table-input w-16"
                               value="${rentK}">
                        <span class="ml-1 text-xs">k</span>
                    </div>
                </td>
                <td id="cashflow-${prop.id}" class="px-6 py-4 whitespace-nowrap text-sm ${cfClass}">${formatHUF(prop.cashflow)}</td>
                <td id="roi5-${prop.id}" class="px-6 py-4 whitespace-nowrap text-sm font-medium ${roi5Class}">${roi5.toFixed(1)}%</td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                    <button onclick="toggleEdit(${prop.id})" class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-900 font-bold">Save</button>
                </td>
            `;
        } else {
            tr.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-zinc-100">${safeName}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">${formatCompact(prop.price)}</td>
                ${commonCells}
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">${prop.rate}%</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">${formatHUF(prop.monthlyPayment)}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">${formatHUF(prop.rent)}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm ${cfClass}">${formatHUF(prop.cashflow)}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium ${roi5Class}">${roi5.toFixed(1)}%</td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                    ${isSharedView ? '' : `
                    <button onclick="toggleEdit(${prop.id})" class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-900 hover:underline">Edit</button>
                    <button onclick="removeProperty(${prop.id})" class="text-red-600 hover:text-red-900 hover:underline">Remove</button>
                    `}
                </td>
            `;
        }

        tableBody.appendChild(tr);
    });
}

const chartColors = [
    { border: '#4F46E5', bg: 'rgba(79, 70, 229, 0.1)' },
    { border: '#059669', bg: 'rgba(5, 150, 105, 0.1)' },
    { border: '#DC2626', bg: 'rgba(220, 38, 38, 0.1)' },
    { border: '#D97706', bg: 'rgba(217, 119, 6, 0.1)' },
    { border: '#7C3AED', bg: 'rgba(124, 58, 237, 0.1)' }
];

function renderCharts() {
    const years = preferences.chartYears;
    const labels = Array.from({length: years + 1}, (_, i) => `Year ${i}`);
    const gridColor = isDark() ? '#3f3f46' : '#f3f4f6';
    const tickColor = isDark() ? '#a1a1aa' : undefined;

    const valueDatasets = properties.map((prop, index) => {
        const data = [];
        let currentValue = prop.afterRenoValue || prop.price;
        for (let i = 0; i <= years; i++) {
            data.push(currentValue);
            currentValue = currentValue * (1 + (settings.inflation / 100));
        }
        const style = chartColors[index % chartColors.length];
        return {
            label: prop.name,
            data: data,
            borderColor: style.border,
            backgroundColor: style.bg,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 6,
            fill: false,
            tension: 0.4
        };
    });

    // Deduplicated: use calculateProjectedROI instead of inline logic
    const roiDatasets = properties.map((prop, index) => {
        const data = [];
        for (let i = 0; i <= years; i++) {
            data.push(calculateProjectedROI(prop, i));
        }
        const style = chartColors[index % chartColors.length];
        return {
            label: prop.name,
            data: data,
            borderColor: style.border,
            backgroundColor: style.bg,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 6,
            fill: false,
            tension: 0.4
        };
    });

    const benchmarkRate = (parseFloat(benchmarkRateInput.value) || 0) / 100;
    const bondData = [];
    for (let i = 0; i <= years; i++) {
        const bondRoi = (Math.pow(1 + benchmarkRate, i) - 1) * 100;
        bondData.push(bondRoi);
    }
    roiDatasets.push({
        label: `Benchmark (${benchmarkRateInput.value}%)`,
        data: bondData,
        borderColor: '#4b5563',
        borderDash: [5, 5],
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: false,
        tension: 0.4,
        order: 99
    });

    const ctxValue = document.getElementById('valueChart').getContext('2d');
    if (valueChartInstance) valueChartInstance.destroy();
    valueChartInstance = new Chart(ctxValue, {
        type: 'line',
        data: { labels: labels, datasets: valueDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) {
                                label += new Intl.NumberFormat('hu-HU', { style: 'currency', currency: 'HUF', maximumFractionDigits: 0 }).format(context.parsed.y);
                            }
                            return label;
                        }
                    }
                },
                legend: { position: 'top', labels: { color: tickColor } }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: tickColor } },
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: tickColor,
                        callback: function(value) {
                            return new Intl.NumberFormat('hu-HU', { notation: "compact", compactDisplay: "short" }).format(value) + ' Ft';
                        }
                    },
                    grid: { color: gridColor }
                }
            }
        }
    });

    const ctxRoi = document.getElementById('roiChart').getContext('2d');
    if (roiChartInstance) roiChartInstance.destroy();
    roiChartInstance = new Chart(ctxRoi, {
        type: 'line',
        data: { labels: labels, datasets: roiDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) {
                                label += context.parsed.y.toFixed(1) + '%';
                            }
                            return label;
                        }
                    }
                },
                legend: { position: 'top', labels: { color: tickColor } }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: tickColor } },
                y: {
                    ticks: {
                        color: tickColor,
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    grid: { color: gridColor }
                }
            }
        }
    });

    // ROI Value Chart (absolute HUF)
    const roiValueDatasets = properties.map((prop, index) => {
        const data = [];
        for (let i = 0; i <= years; i++) {
            data.push(calculateProjectedProfit(prop, i));
        }
        const style = chartColors[index % chartColors.length];
        return {
            label: prop.name,
            data: data,
            borderColor: style.border,
            backgroundColor: style.bg,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 6,
            fill: false,
            tension: 0.4
        };
    });

    const bondValueData = [];
    for (let i = 0; i <= years; i++) {
        const avgInvested = properties.reduce((sum, p) => sum + p.totalInvested, 0) / properties.length;
        bondValueData.push(avgInvested * (Math.pow(1 + benchmarkRate, i) - 1));
    }
    roiValueDatasets.push({
        label: `Benchmark (${benchmarkRateInput.value}%)`,
        data: bondValueData,
        borderColor: '#4b5563',
        borderDash: [5, 5],
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: false,
        tension: 0.4,
        order: 99
    });

    const ctxRoiValue = document.getElementById('roiValueChart').getContext('2d');
    if (roiValueChartInstance) roiValueChartInstance.destroy();
    roiValueChartInstance = new Chart(ctxRoiValue, {
        type: 'line',
        data: { labels: labels, datasets: roiValueDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) {
                                label += new Intl.NumberFormat('hu-HU', { style: 'currency', currency: 'HUF', maximumFractionDigits: 0 }).format(context.parsed.y);
                            }
                            return label;
                        }
                    }
                },
                legend: { position: 'top', labels: { color: tickColor } }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: tickColor } },
                y: {
                    ticks: {
                        color: tickColor,
                        callback: function(value) {
                            return new Intl.NumberFormat('hu-HU', { notation: "compact", compactDisplay: "short" }).format(value) + ' Ft';
                        }
                    },
                    grid: { color: gridColor }
                }
            }
        }
    });

    // Equity Chart (Property Value - Remaining Loan)
    const equityDatasets = properties.map((prop, index) => {
        const data = [];
        let currentValue = prop.afterRenoValue || prop.price;
        for (let i = 0; i <= years; i++) {
            const remainingLoan = getRemainingBalance(prop.loanAmount, prop.rate, prop.term, i);
            data.push(currentValue - remainingLoan);
            currentValue = currentValue * (1 + (settings.inflation / 100));
        }
        const style = chartColors[index % chartColors.length];
        return {
            label: prop.name,
            data: data,
            borderColor: style.border,
            backgroundColor: style.bg,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 6,
            fill: false,
            tension: 0.4
        };
    });

    const ctxEquity = document.getElementById('equityChart').getContext('2d');
    if (equityChartInstance) equityChartInstance.destroy();
    equityChartInstance = new Chart(ctxEquity, {
        type: 'line',
        data: { labels: labels, datasets: equityDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) {
                                label += new Intl.NumberFormat('hu-HU', { style: 'currency', currency: 'HUF', maximumFractionDigits: 0 }).format(context.parsed.y);
                            }
                            return label;
                        }
                    }
                },
                legend: { position: 'top', labels: { color: tickColor } }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: tickColor } },
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: tickColor,
                        callback: function(value) {
                            return new Intl.NumberFormat('hu-HU', { notation: "compact", compactDisplay: "short" }).format(value) + ' Ft';
                        }
                    },
                    grid: { color: gridColor }
                }
            }
        }
    });
}

initApp();
