const express = require('express');
const app = express();

// Library imports - same as the CLI tools use
const generateIOB = require('./lib/iob');
const getLastGlucose = require('./lib/glucose-get-last');
const determine_basal = require('./lib/determine-basal/determine-basal');
const generateMeal = require('./lib/meal');
const tempBasalFunctions = require('./lib/basal-set-temp');

// Middleware
app.use(express.json({ limit: '10mb' }));

// In-memory patient data store
const patients = {};

// Utility functions for data management
class PatientDataManager {
    constructor(patientId) {
        this.patientId = patientId;
    }

    static createPatient(patientId, profile, initialData = {}, settings = {}) {
        const defaultSettings = {
            timezone: 'UTC',
            historyRetentionPeriod: 'weeks', // 'hours', 'days', 'weeks', 'months'
            historyRetentionValue: 1,       // default to 1 week
            autoCleanup: true
        };

        patients[patientId] = {
            profile: profile,
            history: {
                glucose: initialData.glucoseHistory || [],
                pump: initialData.pumpHistory || [],
                carbs: initialData.carbHistory || []
            },
            currentState: {
                tempBasal: initialData.currentTempBasal || null,
                lastCalculation: null,
                cachedIOB: null,
                cachedMeal: null
            },
            settings: { ...defaultSettings, ...settings },
            createdAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString()
        };

        // Sort all history arrays by timestamp
        this.sortHistoryArrays(patientId);

        return patients[patientId];
    }

    static sortHistoryArrays(patientId) {
        const patient = patients[patientId];
        if (!patient) return;

        // Sort glucose by date (newest first)
        patient.history.glucose.sort((a, b) => b.date - a.date);

        // Sort pump events by timestamp (newest first) 
        patient.history.pump.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Sort carbs by timestamp (newest first)
        patient.history.carbs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    static patientExists(patientId) {
        return patientId in patients;
    }

    static getPatient(patientId) {
        return patients[patientId];
    }

    static deletePatient(patientId) {
        delete patients[patientId];
    }

    static addNewData(patientId, newData) {
        const patient = patients[patientId];
        if (!patient) throw new Error('Patient not found');
        // Add new glucose readings
        if (newData.glucoseReadings && Array.isArray(newData.glucoseReadings)) {
            const renamedReadings = newData.glucoseReadings.map(reading => ({
                ...reading,
                dateString: reading.timestamp,
                // timestamp: undefined
            }));
            patient.history.glucose.push(...renamedReadings);
        }

        // Add new pump events
        if (newData.pumpEvents && Array.isArray(newData.pumpEvents)) {
            patient.history.pump.push(...newData.pumpEvents);
        }

        // Add new carb entries
        if (newData.carbEntries && Array.isArray(newData.carbEntries)) {
            patient.history.carbs.push(...newData.carbEntries);
        }

        // Re-sort arrays
        this.sortHistoryArrays(patientId);

        // Auto-cleanup if enabled
        if (patient.settings.autoCleanup) {
            this.cleanupOldData(patientId);
        }

        patient.lastUpdated = new Date().toISOString();
    }

    static cleanupOldData(patientId) {
        const patient = patients[patientId];
        if (!patient) return;

        // Find the newest timestamp from all data sources
        let newestTime = 0;
        
        // Check glucose history
        if (patient.history.glucose.length > 0) {
            const newestGlucose = Math.max(...patient.history.glucose.map(g => g.date));
            newestTime = Math.max(newestTime, newestGlucose);
        }
        
        // Check pump history
        if (patient.history.pump.length > 0) {
            const newestPump = Math.max(...patient.history.pump.map(p => new Date(p.timestamp).getTime()));
            newestTime = Math.max(newestTime, newestPump);
        }
        
        // Check carb history
        if (patient.history.carbs.length > 0) {
            const newestCarb = Math.max(...patient.history.carbs.map(c => new Date(c.timestamp).getTime()));
            newestTime = Math.max(newestTime, newestCarb);
        }
        
        // If no data exists, skip cleanup
        if (newestTime === 0) return;

        // Calculate cutoff time based on retention settings and newest data
        let cutoffTime;
        const retentionValue = patient.settings.historyRetentionValue || 1;
        const retentionPeriod = patient.settings.historyRetentionPeriod || 'weeks';

        switch (retentionPeriod) {
            case 'hours':
                cutoffTime = newestTime - (retentionValue * 60 * 60 * 1000);
                break;
            case 'days':
                cutoffTime = newestTime - (retentionValue * 24 * 60 * 60 * 1000);
                break;
            case 'weeks':
                cutoffTime = newestTime - (retentionValue * 7 * 24 * 60 * 60 * 1000);
                break;
            case 'months':
                cutoffTime = newestTime - (retentionValue * 30 * 24 * 60 * 60 * 1000);
                break;
            default:
                // Fallback to hours if invalid period
                cutoffTime = newestTime - (retentionValue * 60 * 60 * 1000);
        }

        // Clean glucose history
        const beforeGlucose = patient.history.glucose.length;
        patient.history.glucose = patient.history.glucose.filter(g => g.date >= cutoffTime);

        // Clean pump history
        const beforePump = patient.history.pump.length;
        patient.history.pump = patient.history.pump.filter(p =>
            new Date(p.timestamp).getTime() >= cutoffTime
        );

        // Clean carb history
        const beforeCarbs = patient.history.carbs.length;
        patient.history.carbs = patient.history.carbs.filter(c =>
            new Date(c.timestamp).getTime() >= cutoffTime
        );


        if (beforeGlucose == patient.history.glucose.length&&
            beforePump == patient.history.pump.length &&
            beforeCarbs == patient.history.carbs.length) {
            return;
        }
        console.log(`Cleaned up data older than ${retentionValue} ${retentionPeriod} from newest data point for patient ${patientId}.` +
                    ` Removed: ${beforeGlucose - patient.history.glucose.length} glucose,` +
                    ` ${beforePump - patient.history.pump.length} pump,` +
                    ` ${beforeCarbs - patient.history.carbs.length} carb entries`);
    }

    static validateProfile(profile) {
        const required = ['carb_ratio', 'sens', 'dia', 'max_bg', 'min_bg', 'current_basal'];
        const missing = required.filter(field => !(field in profile));

        if (missing.length > 0) {
            throw new Error(`Missing required profile fields: ${missing.join(', ')}`);
        }

        if (profile.carb_ratio < 3) {
            throw new Error(`carb_ratio ${profile.carb_ratio} out of bounds (minimum 3)`);
        }

        if (profile.sens <= 0) {
            throw new Error(`sens ${profile.sens} must be positive`);
        }

        return true;
    }

    static getPatientStatus(patientId) {
        const patient = patients[patientId];
        if (!patient) return null;

        const lastGlucose = patient.history.glucose[0] || null;
        const trend = this.calculateGlucoseTrend(patient.history.glucose);

        return {
            patientId: patientId,
            lastCalculation: patient.currentState.lastCalculation?.timestamp || null,
            currentIOB: patient.currentState.cachedIOB ? patient.currentState.cachedIOB[0]?.iob : null,
            currentCOB: patient.currentState.cachedMeal?.mealCOB || null,
            lastGlucose: lastGlucose ? {
                value: lastGlucose.glucose,
                timestamp: new Date(lastGlucose.date).toISOString(),
                trend: trend
            } : null,
            currentTempBasal: patient.currentState.tempBasal,
            historyCount: {
                glucose: patient.history.glucose.length,
                pump: patient.history.pump.length,
                carbs: patient.history.carbs.length
            },
            createdAt: patient.createdAt,
            lastUpdated: patient.lastUpdated
        };
    }

    static calculateGlucoseTrend(glucoseHistory) {
        if (glucoseHistory.length < 2) return 0;

        const latest = glucoseHistory[0].glucose;
        const previous = glucoseHistory[1].glucose;
        return latest - previous;
    }
}

// OpenAPS calculation functions (same as before but using patient data)
function calculateIOBForPatient(patientId, clock, autosensData = null) {
    const patient = patients[patientId];
    if (!patient) throw new Error('Patient not found');

    const inputs = {
        history: patient.history.pump,
        history24: null, // Could implement 24h history if needed
        profile: patient.profile,
        clock: clock
    };

    if (autosensData) {
        inputs.autosens = autosensData;
    }

    return generateIOB(inputs);
}

function calculateMealForPatient(patientId, clock) {
    const patient = patients[patientId];
    if (!patient) throw new Error('Patient not found');

    // Validate profile
    PatientDataManager.validateProfile(patient.profile);

    const inputs = {
        history: patient.history.pump,
        profile: patient.profile,
        basalprofile: patient.profile.basalprofile || [
            { minutes: 0, rate: patient.profile.current_basal, start: "00:00:00", i: 0 }
        ],
        clock: clock,
        carbs: patient.history.carbs,
        glucose: patient.history.glucose
    };

    const recentCarbs = generateMeal(inputs);

    if (patient.history.glucose.length < 36) {
        recentCarbs.mealCOB = 0;
        recentCarbs.reason = "not enough glucose data to calculate carb absorption";
    }

    return recentCarbs;
}

function calculateBasalForPatient(patientId, currentTime, options = {}) {
    const patient = patients[patientId];
    if (!patient) throw new Error('Patient not found');

    // Calculate IOB
    const iobData = calculateIOBForPatient(patientId, currentTime, options.autosens);

    // Calculate meal data
    const mealData = calculateMealForPatient(patientId, currentTime);

    // Get glucose status
    const glucoseStatus = getLastGlucose(patient.history.glucose);

    if (!glucoseStatus) {
        throw new Error('No glucose data available for calculation');
    }

    // Apply profile overrides if provided
    const effectiveProfile = { ...patient.profile, ...options.overrideProfile };

    // Get current temp basal
    const currentTemp = patient.currentState.tempBasal || { rate: effectiveProfile.current_basal, duration: 0 };

    // Calculate basal recommendation
    const suggestion = determine_basal(
        glucoseStatus,
        currentTemp,
        iobData,
        effectiveProfile,
        options.autosens,
        mealData,
        tempBasalFunctions,
        options.microbolus || false,
        null, // reservoir_data
        new Date(currentTime).getTime()
    );

    // Cache results
    patient.currentState.cachedIOB = iobData;
    patient.currentState.cachedMeal = mealData;
    patient.currentState.lastCalculation = {
        timestamp: currentTime,
        suggestion: suggestion
    };

    return {
        suggestion: suggestion,
        iob: iobData[0], // Return first IOB entry for immediate use
        meal: mealData,
        glucoseStatus: glucoseStatus
    };
}

// API Endpoints

// 1. Initialize Patient
app.post('/patients/:patientId/initialize', (req, res) => {
    try {
        const { patientId } = req.params;
        const { profile, initialData = {}, settings = {} } = req.body;

        if (!profile) {
            return res.status(400).json({ error: 'Profile is required' });
        }

        // Validate profile
        PatientDataManager.validateProfile(profile);

        // Create or recreate patient
        const patient = PatientDataManager.createPatient(patientId, profile, initialData, settings);

        res.status(201).json({
            message: 'Patient initialized successfully',
            patientId: patientId,
            status: PatientDataManager.getPatientStatus(patientId)
        });

    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 2. Calculate Basal
app.post('/patients/:patientId/calculate', (req, res) => {
    //   try {
    const { patientId, glucose } = req.params;
    const { currentTime, newData = {}, options = {} } = req.body;
    if (!PatientDataManager.patientExists(patientId)) {
        return res.status(404).json({ error: 'Patient not found' });
    }

    if (!currentTime) {
        return res.status(400).json({ error: 'currentTime is required' });
    }

    // Add new data to patient history
    if (Object.keys(newData).length > 0) {
        PatientDataManager.addNewData(patientId, newData);
    }
    // console.log('new data')
    // console.log(newData)
    console.log(patients[patientId].history.glucose)
    // Calculate basal recommendation
    const result = calculateBasalForPatient(patientId, currentTime, options);

    res.json({
        patientId: patientId,
        timestamp: currentTime,
        suggestion: result.suggestion,
        context: {
            iob: result.iob,
            meal: result.meal,
            glucose: result.glucoseStatus
        }
    });

    //   } catch (error) {
    //     res.status(500).json({ error: error.message });
    //   }
});

// 3. Get Patient Status
app.get('/patients/:patientId/status', (req, res) => {
    try {
        const { patientId } = req.params;

        if (!PatientDataManager.patientExists(patientId)) {
            return res.status(404).json({ error: 'Patient not found' });
        }

        const status = PatientDataManager.getPatientStatus(patientId);
        res.json(status);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Get Patient History
app.get('/patients/:patientId/history', (req, res) => {
    try {
        const { patientId } = req.params;
        const { type = 'all', hours = 6, limit = 100 } = req.query;

        if (!PatientDataManager.patientExists(patientId)) {
            return res.status(404).json({ error: 'Patient not found' });
        }

        const patient = patients[patientId];
        const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

        let result = {};

        if (type === 'all' || type === 'glucose') {
            result.glucose = patient.history.glucose
                .filter(g => g.date >= cutoffTime)
                .slice(0, limit);
        }

        if (type === 'all' || type === 'pump') {
            result.pump = patient.history.pump
                .filter(p => new Date(p.timestamp).getTime() >= cutoffTime)
                .slice(0, limit);
        }

        if (type === 'all' || type === 'carbs') {
            result.carbs = patient.history.carbs
                .filter(c => new Date(c.timestamp).getTime() >= cutoffTime)
                .slice(0, limit);
        }

        res.json({
            patientId: patientId,
            requestedType: type,
            requestedHours: hours,
            result: result
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Update Profile
app.patch('/patients/:patientId/profile', (req, res) => {
    try {
        const { patientId } = req.params;
        const profileUpdates = req.body;

        if (!PatientDataManager.patientExists(patientId)) {
            return res.status(404).json({ error: 'Patient not found' });
        }

        const patient = patients[patientId];

        // Apply updates
        Object.assign(patient.profile, profileUpdates);

        // Validate updated profile
        PatientDataManager.validateProfile(patient.profile);

        patient.lastUpdated = new Date().toISOString();

        res.json({
            message: 'Profile updated successfully',
            patientId: patientId,
            updatedFields: Object.keys(profileUpdates),
            profile: patient.profile
        });

    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 6. List Patients
app.get('/patients', (req, res) => {
    try {
        const patientList = Object.keys(patients).map(patientId => ({
            patientId: patientId,
            ...PatientDataManager.getPatientStatus(patientId)
        }));

        res.json({
            count: patientList.length,
            patients: patientList
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. Delete Patient
app.delete('/patients/:patientId', (req, res) => {
    try {
        const { patientId } = req.params;

        if (!PatientDataManager.patientExists(patientId)) {
            return res.status(404).json({ error: 'Patient not found' });
        }

        PatientDataManager.deletePatient(patientId);

        res.json({
            message: 'Patient deleted successfully',
            patientId: patientId
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test Case Functionality

// Sample test data
const testCases = {
    basicPatient: {
        profile: {
            carb_ratio: 10,
            sens: 50,
            dia: 6,
            max_bg: 120,
            min_bg: 80,
            max_basal: 4.0,
            current_basal: 1.0,
            max_iob: 6.0,
            max_daily_safety_multiplier: 4,
            current_basal_safety_multiplier: 5,
            autosens_max: 2,
            autosens_min: 0.5,
            enableSMB_with_bolus: true,
            enableSMB_with_COB: true,
            curve: "rapid-acting",
            insulinPeakTime: 75,
            basalprofile: [
                { minutes: 0, rate: 1.0, start: "00:00:00", i: 0 },
                { minutes: 360, rate: 0.8, start: "06:00:00", i: 1 },
                { minutes: 720, rate: 1.2, start: "12:00:00", i: 2 },
                { minutes: 1080, rate: 0.9, start: "18:00:00", i: 3 }
            ]
        },
        initialData: {
            pumpHistory: [
                {
                    timestamp: "2024-01-01T09:45:00Z",
                    _type: "Bolus",
                    amount: 2.5,
                    duration: 0
                },
                {
                    timestamp: "2024-01-01T09:50:00Z",
                    _type: "TempBasal",
                    temp: "absolute",
                    rate: 0.5
                }
            ],
            glucoseHistory: [
                { date: 1704110700000, glucose: 115, timestamp: "2024-01-01T10:05:00Z" },
                { date: 1704110400000, glucose: 120, timestamp: "2024-01-01T10:00:00Z" },
                { date: 1704110100000, glucose: 125, timestamp: "2024-01-01T09:55:00Z" },
                { date: 1704109800000, glucose: 130, timestamp: "2024-01-01T09:50:00Z" },
                { date: 1704109500000, glucose: 128, timestamp: "2024-01-01T09:45:00Z" }
            ],
            carbHistory: [
                {
                    timestamp: "2024-01-01T09:30:00Z",
                    carbs: 45,
                    enteredBy: "patient"
                }
            ],
            currentTempBasal: {
                rate: 0.5,
                duration: 25,
                timestamp: "2024-01-01T09:50:00Z"
            }
        }
    },

    emergencyPatient: {
        profile: {
            carb_ratio: 8,
            sens: 40,
            dia: 5,
            max_bg: 150,
            min_bg: 70,
            max_basal: 6.0,
            current_basal: 1.5,
            max_iob: 8.0,
            curve: "ultra-rapid",
            insulinPeakTime: 55
        },
        initialData: {
            glucoseHistory: [
                { date: Date.now(), glucose: 250, timestamp: new Date().toISOString() }
            ]
        }
    }
};

// 8. Create Test Patient
app.post('/test/patients/:testCase', (req, res) => {
    try {
        const { testCase } = req.params;
        const { patientId = `test-${testCase}-${Date.now()}` } = req.body;

        if (!testCases[testCase]) {
            return res.status(400).json({
                error: 'Invalid test case',
                availableTestCases: Object.keys(testCases)
            });
        }

        const testData = testCases[testCase];
        const patient = PatientDataManager.createPatient(patientId, testData.profile, testData.initialData);

        res.status(201).json({
            message: `Test patient created using ${testCase} test case`,
            patientId: patientId,
            testCase: testCase,
            status: PatientDataManager.getPatientStatus(patientId)
        });

    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 9. Run Test Scenario
app.post('/test/scenario/:patientId', (req, res) => {
    try {
        const { patientId } = req.params;
        const { scenario = 'basic' } = req.body;

        if (!PatientDataManager.patientExists(patientId)) {
            return res.status(404).json({ error: 'Test patient not found' });
        }

        const results = [];
        const baseTime = new Date();

        // Run scenario based on type
        switch (scenario) {
            case 'basic':
                // Test basic calculation sequence
                for (let i = 0; i < 3; i++) {
                    const currentTime = new Date(baseTime.getTime() + (i * 5 * 60 * 1000)).toISOString();
                    const glucoseValue = 115 - (i * 2); // Slowly declining

                    // Add new glucose reading
                    PatientDataManager.addNewData(patientId, {
                        glucoseReadings: [
                            { date: Date.parse(currentTime), glucose: glucoseValue, timestamp: currentTime }
                        ]
                    });

                    // Calculate
                    const result = calculateBasalForPatient(patientId, currentTime);
                    results.push({
                        step: i + 1,
                        time: currentTime,
                        glucose: glucoseValue,
                        suggestion: result.suggestion
                    });
                }
                break;

            case 'meal':
                // Test meal scenario
                const mealTime = baseTime.toISOString();

                // Add carbs
                PatientDataManager.addNewData(patientId, {
                    carbEntries: [
                        { timestamp: mealTime, carbs: 60, enteredBy: "test" }
                    ]
                });

                // Simulate glucose rise
                for (let i = 0; i < 6; i++) {
                    const currentTime = new Date(baseTime.getTime() + (i * 10 * 60 * 1000)).toISOString();
                    const glucoseValue = 120 + (i * 15); // Rising glucose

                    PatientDataManager.addNewData(patientId, {
                        glucoseReadings: [
                            { date: Date.parse(currentTime), glucose: glucoseValue, timestamp: currentTime }
                        ]
                    });

                    const result = calculateBasalForPatient(patientId, currentTime);
                    results.push({
                        step: i + 1,
                        time: currentTime,
                        glucose: glucoseValue,
                        suggestion: result.suggestion
                    });
                }
                break;

            default:
                return res.status(400).json({ error: 'Unknown scenario type' });
        }

        res.json({
            patientId: patientId,
            scenario: scenario,
            results: results,
            summary: {
                steps: results.length,
                finalGlucose: results[results.length - 1]?.glucose,
                finalBasalRate: results[results.length - 1]?.suggestion?.rate
            }
        });

    } catch (error) {
        console.log(error);
        res.status(500).json({ error: error.message });
    }
});

// 10. List Test Cases
app.get('/test/cases', (req, res) => {
    res.json({
        availableTestCases: Object.keys(testCases),
        testCases: testCases
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Multi-Patient OpenAPS server is running',
        timestamp: new Date().toISOString(),
        activePatients: Object.keys(patients).length
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Multi-Patient OpenAPS server running on port ${PORT}`);
    console.log(`\nAvailable endpoints:`);
    console.log(`  POST /patients/{id}/initialize     - Create patient profile`);
    console.log(`  POST /patients/{id}/calculate      - Calculate basal recommendation`);
    console.log(`  GET  /patients/{id}/status         - Get patient status`);
    console.log(`  GET  /patients/{id}/history        - Get patient history`);
    console.log(`  PATCH /patients/{id}/profile       - Update patient profile`);
    console.log(`  GET  /patients                     - List all patients`);
    console.log(`  DELETE /patients/{id}              - Delete patient`);
    console.log(`\nTest endpoints:`);
    console.log(`  POST /test/patients/{testCase}     - Create test patient`);
    console.log(`  POST /test/scenario/{id}           - Run test scenario`);
    console.log(`  GET  /test/cases                   - List test cases`);
    console.log(`  GET  /health                       - Health check`);
});

module.exports = app;