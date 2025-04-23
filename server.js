// server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const fs = require('fs');
const path = require('path'); // Node.js path module
const { parse } = require('csv-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

// --- Configuration ---
const CSV_FILE_PATH = './earthquakes.csv';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_DISTANCE_KM = 100; // Max distance to consider nearby historical earthquakes
const MAX_HISTORICAL_EVENTS = 10; // Max number of historical events to feed Gemini

if (!GEMINI_API_KEY) {
    console.error("Error: GEMINI_API_KEY not found in environment variables.");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Or choose another model

// --- Middleware ---
app.use(express.json()); // Parse JSON request bodies
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files (HTML, CSS, JS)

// --- Data Loading and Processing ---
let earthquakeData = [];

function loadEarthquakeData() {
    console.log(`Loading earthquake data from ${CSV_FILE_PATH}...`);
    const parser = fs.createReadStream(CSV_FILE_PATH)
        .pipe(parse({
            columns: true,
            skip_empty_lines: true,
            cast: (value, context) => {
                // Attempt to cast specific columns to numbers
                if (['magnitude', 'latitude', 'longitude', 'depth', 'felt', 'cdi', 'mmi', 'sig', 'nst', 'dmin', 'rms', 'gap', 'distanceKM'].includes(context.column)) {
                    const num = parseFloat(value);
                    return isNaN(num) ? null : num; // Handle potential non-numeric values gracefully
                }
                // Cast time to Date object
                if (context.column === 'time') {
                    const timestamp = parseInt(value, 10);
                    return isNaN(timestamp) ? null : new Date(timestamp);
                }
                return value;
            }
        }));

    parser.on('readable', () => {
        let record;
        while ((record = parser.read()) !== null) {
            // Basic validation: ensure lat/lon exist
            if (record.latitude !== null && record.longitude !== null && record.magnitude !== null && record.time !== null) {
                earthquakeData.push(record);
            }
        }
    });

    parser.on('error', (err) => {
        console.error('Error parsing CSV:', err.message);
        earthquakeData = []; // Clear data on error
    });

    parser.on('end', () => {
        console.log(`Finished loading ${earthquakeData.length} valid earthquake records.`);
        // Sort by time descending (most recent first) - useful for context
        earthquakeData.sort((a, b) => b.time - a.time);
    });
}

// Haversine formula to calculate distance between two lat/lon points
function getDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the Earth in km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
}

function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

// Find nearby historical events
function findNearbyEvents(targetLat, targetLon) {
    if (!earthquakeData || earthquakeData.length === 0) {
        return [];
    }
    return earthquakeData
        .map(event => ({
            ...event,
            distance: getDistanceKm(targetLat, targetLon, event.latitude, event.longitude)
        }))
        .filter(event => event.distance <= MAX_DISTANCE_KM)
        .sort((a, b) => a.distance - b.distance) // Sort by distance ascending
        .slice(0, MAX_HISTORICAL_EVENTS); // Limit the number of events
}


// --- API Endpoint ---
app.post('/predict', async (req, res) => {
    console.log("Received prediction request:", req.body);
    const { dateTime, latitude, longitude } = req.body;

    // Input validation
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    // Basic datetime validation could be added here
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180 || !dateTime) {
        return res.status(400).json({ error: "Invalid input parameters. Provide dateTime (ISO format), latitude (-90 to 90), and longitude (-180 to 180)." });
    }

    if (earthquakeData.length === 0) {
        return res.status(503).json({ error: "Earthquake data not loaded or unavailable. Please try again later." });
    }

    try {
        // 1. Find relevant historical data
        const nearbyEvents = findNearbyEvents(lat, lon);
        let historicalContext = "No significant historical earthquakes found nearby in the provided dataset.";
        if (nearbyEvents.length > 0) {
            historicalContext = `Found ${nearbyEvents.length} historical earthquakes within ${MAX_DISTANCE_KM} km. Recent/nearby events include:\n`;
            historicalContext += nearbyEvents.map(e =>
                `- Magnitude ${e.magnitude} on ${e.time.toISOString().split('T')[0]} at depth ${e.depth || 'N/A'} km (${e.distance.toFixed(1)} km away)`
            ).join('\n');
            // Could add average/max magnitude etc. here too
        }

        // 2. Construct Prompt for Gemini
        // IMPORTANT: Frame this as risk assessment/contextual analysis, NOT prediction.
        const prompt = `

        **Analysis Request:**
        Assess the general natural disaster activity level and potential risk for the location:
        Latitude: ${lat}
        Longitude: ${lon}

        **Historical Context from provided dataset (within ${MAX_DISTANCE_KM}km, limited to ${MAX_HISTORICAL_EVENTS} events, sorted by distance for each disaster type):**
        ${historicalContext}

        **Task:**
        Based on the provided historical context AND your general knowledge of regional geography, geology, climate, and historical disaster patterns for this specific latitude and longitude:

        For **Earthquakes**:
        1. Describe the general tectonic setting of this area.
        2. Assess the *general* level of seismic activity typically expected for this location (e.g., low, moderate, high, very high).
        3. If earthquakes *were* to occur, what is a typical magnitude range based on historical patterns and known fault characteristics?
        4. Mention any major known fault lines nearby, if applicable.
        5. Briefly summarize the potential seismic risk level for this specific location, keeping in mind the inherent unpredictability.

        For **Wildfires**:
        6. Describe the typical vegetation, climate patterns, and any known history of significant wildfires in this region.
        7. Assess the *general* level of wildfire risk for this location (e.g., low, moderate, high). Consider factors like dry seasons, vegetation density, and human activity.
        8. If wildfires *were* to occur, what are typical contributing factors and potential scale based on historical events and regional characteristics?
        9. Mention any nearby geographical features or human developments that might increase or decrease wildfire risk.
        10. Briefly summarize the potential wildfire risk level for this specific location.

        For **Tsunamis**:
        11. Describe the proximity of this location to major bodies of water and known sources of tsunamigenic activity (e.g., subduction zones, major offshore faults, historical landslide areas).
        12. Assess the *general* level of tsunami risk for this location (e.g., very low, low, moderate, high).
        13. If a tsunami *were* to impact this area, what might be a typical inundation level or historical precedent?
        14. Mention any geographical features (e.g., shallow continental shelf, bays) that might amplify or mitigate tsunami impact.
        15. Briefly summarize the potential tsunami risk level for this specific location.

        For **Other Natural Disasters** (e.g., floods, cyclones/hurricanes, landslides, volcanic activity, extreme weather events):
        16. Identify other significant types of natural disasters that have historically affected or are geographically relevant to this region.
        17. For each identified disaster type, briefly assess the *general* level of risk (e.g., low, moderate, high).
        18. Mention any specific geographical or meteorological factors that contribute to these risks.
        19. Briefly summarize the potential risk level for these other natural disasters for this specific location.

        **Output Format:** Provide a concise summary addressing points 1-19. Start the response with the disclaimer: "Please note that this analysis is a general assessment based on available information and models. Natural disaster risks are inherently complex and can change over time. This analysis should not be used for critical decision-making without consulting local experts and official resources." Provide each disaster type's analysis in a separate, clearly labeled section.
        `;

        console.log("\n--- Sending Prompt to Gemini ---");
        // console.log(prompt); // Uncomment to debug the prompt
        console.log("----------------------------\n");

        // 3. Call Gemini API
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const geminiText = response.text();

        console.log("-----------------------------------\n");

        // 4. Send Response to Client
        res.json({
            request: { dateTime, latitude: lat, longitude: lon },
            historical_context_summary: historicalContext.split('\n')[0], // Just the summary line
            nearby_events_count: nearbyEvents.length,
            // nearby_events_details: nearbyEvents, // Optional: send details if needed by frontend
            gemini_assessment: geminiText || "Gemini assessment could not be generated."
        });

    } catch (error) {
        console.error("Error during prediction:", error);
        // Check for specific Gemini errors if possible (e.g., content filtering)
        if (error.message.includes('SAFETY')) {
            res.status(500).json({ error: "Gemini assessment failed due to safety settings. The prompt might have triggered content filters." });
        } else {
            res.status(500).json({ error: "An error occurred while processing the prediction." });
        }
    }
});

// --- Start Server ---
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    loadEarthquakeData(); // Load data when server starts
})