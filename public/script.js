// public/script.js
const form = document.getElementById('prediction-form');
const resultsDiv = document.getElementById('results');
const loadingDiv = document.getElementById('loading');
const errorDiv = document.getElementById('error-message');

form.addEventListener('submit', async (event) => {
    event.preventDefault(); // Prevent default form submission

    resultsDiv.innerHTML = '<p>Submit the form to see the analysis.</p>'; // Clear previous results
    errorDiv.style.display = 'none'; // Hide previous errors
    errorDiv.textContent = '';
    loadingDiv.style.display = 'block'; // Show loading indicator

    const formData = new FormData(form);
    const data = {
        // Convert datetime-local to ISO 8601 format (or keep as is if backend handles it)
        dateTime: formData.get('dateTime') ? new Date(formData.get('dateTime')).toISOString() : null,
        latitude: formData.get('latitude'),
        longitude: formData.get('longitude')
    };

    try {
        const response = await fetch('/predict', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });

        loadingDiv.style.display = 'none'; // Hide loading indicator

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }

        const result = await response.json();

        // Display results nicely
        resultsDiv.innerHTML = `
            <h3>Analysis for Location (${result.request.latitude}, ${result.request.longitude})</h3>
            <p><strong>Historical Context:</strong> ${result.historical_context_summary} (${result.nearby_events_count} events found within ${MAX_DISTANCE_KM || 'defined'} km).</p>
            <h4>Gemini AI Assessment:</h4>
            <pre>${result.gemini_assessment.replace(/^\*\*Disclaimer:\*\*.*?\n\n/,'')}</pre> <!-- Show Gemini text, removing the disclaimer we added -->
            <hr>
            <p><i><strong>Reminder:</strong> Earthquake prediction is not currently possible. This assessment uses historical data and AI analysis for general context and risk awareness.</i></p>
        `;

    } catch (error) {
        console.error('Error fetching prediction:', error);
        loadingDiv.style.display = 'none';
        errorDiv.textContent = `Error: ${error.message}`;
        errorDiv.style.display = 'block';
        resultsDiv.innerHTML = '<p>Analysis failed. Please check the console for details.</p>';
    }
});

// --- Add constants from backend if needed for display ---
// These might need to be fetched or hardcoded if they change often
const MAX_DISTANCE_KM = 100;