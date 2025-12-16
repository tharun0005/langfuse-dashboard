window.showSuccess = window.showSuccess || ((msg) => console.log(msg));
window.showError = window.showError || ((msg) => console.error(msg));
window.showInfo = window.showInfo || ((msg) => console.log(msg));
window.showWarning = window.showWarning || ((msg) => console.warn(msg));

// Constants
const ROWS_PER_PAGE = 10;
const PREVIEW_LENGTH = 60;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const CHART_COLORS = [
    'rgba(59, 130, 246, 0.8)',
    'rgba(34, 197, 94, 0.8)',
    'rgba(245, 158, 11, 0.8)',
    'rgba(239, 68, 68, 0.8)',
    'rgba(168, 85, 247, 0.8)',
    'rgba(14, 165, 233, 0.8)',
    'rgba(236, 72, 153, 0.8)',
    'rgba(163, 230, 53, 0.8)'
];

// State
let latencyChart = null;
let modelChart = null;
let currentPage = 1;
let allItems = [];
let isLoading = false;

// Properly handle API response
async function fetchTraces(limit) {
    const res = await fetch(`/api/traces?limit=${encodeURIComponent(limit)}`);
    if (!res.ok) throw new Error(`Failed to fetch traces: ${res.status}`);
    const data = await res.json();
    // Handle both response formats
    return Array.isArray(data) ? data : (data.traces || []);
}

function updateKpis(items) {
    const total = items.length;
    const avgLatency = total
        ? items.reduce((sum, x) => sum + (x.latency_ms || 0), 0) / total
        : 0;
    const avgTokens = total
        ? items.reduce((sum, x) => sum + (x.total_tokens || 0), 0) / total
        : 0;

    document.getElementById('kpi-total').textContent = total.toLocaleString();
    document.getElementById('kpi-latency').textContent = avgLatency.toFixed(1);
    document.getElementById('kpi-tokens').textContent = avgTokens.toFixed(1);
}

function updateTable(items, page = 1, perPage = ROWS_PER_PAGE) {
    const tbody = document.getElementById('callsBody');
    tbody.innerHTML = '';

    const start = (page - 1) * perPage;
    const end = start + perPage;
    const pageItems = items.slice(start, end);

    pageItems.forEach(item => {
        const tr = document.createElement('tr');

        // Time cell
        const timeCell = document.createElement('td');
        try {
            timeCell.textContent = item.time ? new Date(item.time).toLocaleString() : '-';
            timeCell.title = item.time || '';
        } catch (e) {
            timeCell.textContent = '-';
            console.warn('Invalid date:', item.time);
        }

        // Model cell
        const modelCell = document.createElement('td');
        modelCell.textContent = item.model || '-';

        // Latency cell
        const latencyCell = document.createElement('td');
        latencyCell.textContent =
            item.latency_ms !== null && item.latency_ms !== undefined
                ? item.latency_ms.toLocaleString()
                : '-';

        // Token calculation - properly handle 0 values
        const tokensCell = document.createElement('td');
        const totalTokens = (item.total_tokens !== null && item.total_tokens !== undefined)
            ? item.total_tokens
            : null;
        const inputTokens = item.input_tokens || 0;
        const outputTokens = item.output_tokens || 0;

        tokensCell.textContent = totalTokens !== null ? totalTokens.toLocaleString() : '-';
        tokensCell.title =
            `Input tokens: ${inputTokens.toLocaleString()}\n` +
            `Output tokens: ${outputTokens.toLocaleString()}\n` +
            `Total tokens: ${totalTokens !== null ? totalTokens.toLocaleString() : '0'}`;

        // Input cell
        const inputCell = document.createElement('td');
        const inputPreview = (item.input_content || '').slice(0, PREVIEW_LENGTH);
        inputCell.textContent =
            inputPreview +
            (inputPreview.length < (item.input_content?.length || 0) ? '...' : '');
        inputCell.title = item.input_content || '';

        // Output cell
        const outputCell = document.createElement('td');
        const outputPreview = (item.output_content || '').slice(0, PREVIEW_LENGTH);
        outputCell.textContent =
            outputPreview +
            (outputPreview.length < (item.output_content?.length || 0) ? '...' : '');
        outputCell.title = item.output_content || '';

        tr.appendChild(timeCell);
        tr.appendChild(modelCell);
        tr.appendChild(latencyCell);
        tr.appendChild(tokensCell);
        tr.appendChild(inputCell);
        tr.appendChild(outputCell);
        tbody.appendChild(tr);
    });

    updatePaginationControls(items.length, page, perPage);
}

function updatePaginationControls(totalItems, page, perPage) {
    const pagination = document.getElementById('paginationControls');
    const totalPages = Math.ceil(totalItems / perPage);

    if (!totalItems || totalPages <= 1) {
        pagination.classList.add('hidden');
        return;
    }

    pagination.classList.remove('hidden');
    document.getElementById('pageInfo').textContent = `Page ${page} of ${totalPages}`;
    document.getElementById('prevPage').disabled = page <= 1;
    document.getElementById('nextPage').disabled = page >= totalPages;
}

function goToNextPage() {
    const totalPages = Math.ceil(allItems.length / ROWS_PER_PAGE);
    if (currentPage < totalPages) {
        currentPage++;
        updateTable(allItems, currentPage, ROWS_PER_PAGE);
    }
}

function goToPrevPage() {
    if (currentPage > 1) {
        currentPage--;
        updateTable(allItems, currentPage, ROWS_PER_PAGE);
    }
}

function groupByDay(items) {
    const byDay = {};
    items.forEach(x => {
        if (!x.time) return;
        try {
            const key = new Date(x.time).toISOString().slice(0, 10);
            if (!byDay[key]) {
                byDay[key] = {
                    date: key,
                    totalLatency: 0,
                    totalTokens: 0,
                    count: 0
                };
            }
            byDay[key].totalLatency += x.latency_ms || 0;
            byDay[key].totalTokens += x.total_tokens || 0;
            byDay[key].count += 1;
        } catch (e) {
            console.warn('Invalid date in groupByDay:', x.time);
        }
    });
    return Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
}

function buildSeriesByMetric(days, metric) {
    const labels = days.map(d => d.date);
    let data;
    let label;

    if (metric === 'avgLatency') {
        data = days.map(d => d.count ? d.totalLatency / d.count : 0);
        label = 'Average latency (ms) per day';
    } else if (metric === 'totalCalls') {
        data = days.map(d => d.count);
        label = 'Total calls per day';
    } else if (metric === 'totalTokens') {
        data = days.map(d => d.totalTokens);
        label = 'Total tokens per day';
    } else {
        data = [];
        label = 'Unknown Metric';
    }

    return { labels, data, label };
}

function updateChart(items, metricOverride) {
    const container = document.getElementById('chartsContainer');
    const canvas = document.getElementById('latencyChart');
    const ctx = canvas.getContext('2d');

    if (!items.length) {
        if (latencyChart) {
            latencyChart.destroy();
            latencyChart = null;
        }
        container.classList.add('hidden');
        return;
    }

    const days = groupByDay(items);
    const metric = metricOverride || document.getElementById('yMetric')?.value || 'avgLatency';
    const series = buildSeriesByMetric(days, metric);

    if (!latencyChart) {
        latencyChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: series.labels,
                datasets: [{
                    label: series.label,
                    data: series.data,
                    borderColor: 'rgba(59, 130, 246, 1)',
                    backgroundColor: 'rgba(59, 130, 246, 0.2)',
                    tension: 0.25,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: true } },
                scales: {
                    x: { title: { display: true, text: 'Day' } },
                    y: { title: { display: true, text: 'Value' }, beginAtZero: true }
                }
            }
        });
    } else {
        // Update data in place for better performance
        latencyChart.data.labels = series.labels;
        latencyChart.data.datasets[0].data = series.data;
        latencyChart.data.datasets[0].label = series.label;
        latencyChart.update('none'); // No animation for better performance
    }

    container.classList.remove('hidden');
}

function groupByDayAndModel(items) {
    const byDayModel = {};
    items.forEach(x => {
        if (!x.time) return;
        try {
            const dateKey = new Date(x.time).toISOString().slice(0, 10);
            const model = (x.model || 'Unknown').replace(/\|/g, '-'); // Sanitize model name
            const key = `${dateKey}|${model}`;

            if (!byDayModel[key]) {
                byDayModel[key] = {
                    date: dateKey,
                    model: model,
                    count: 0,
                    totalTokens: 0,
                    totalLatency: 0
                };
            }

            byDayModel[key].count += 1;
            byDayModel[key].totalTokens += x.total_tokens || 0;
            byDayModel[key].totalLatency += x.latency_ms || 0;
        } catch (e) {
            console.warn('Invalid date in groupByDayAndModel:', x.time);
        }
    });
    return Object.values(byDayModel);
}

function buildModelChartSeries(items, metric) {
    const grouped = groupByDayAndModel(items);
    const dates = [...new Set(grouped.map(x => x.date))].sort();
    const models = [...new Set(grouped.map(x => x.model))];

    const dataMap = {};
    grouped.forEach(x => {
        if (!dataMap[x.date]) dataMap[x.date] = {};
        if (metric === 'calls') dataMap[x.date][x.model] = x.count;
        if (metric === 'tokens') dataMap[x.date][x.model] = x.totalTokens;
        if (metric === 'avgLatency') dataMap[x.date][x.model] = x.count ? x.totalLatency / x.count : 0;
    });

    const datasets = models.map((model, idx) => {
        const color = CHART_COLORS[idx % CHART_COLORS.length];
        return {
            label: model,
            // Use 0 instead of null for missing data points in stacked charts
            data: dates.map(date => (dataMap[date] && (model in dataMap[date])) ? dataMap[date][model] : 0),
            backgroundColor: color,
            borderColor: color.replace('0.8', '1'),
            borderWidth: 1
        };
    });

    return { labels: dates, datasets };
}

function updateModelChart(items, metricOverride) {
    const container = document.getElementById('chartsContainer');
    const canvas = document.getElementById('modelChart');
    const ctx = canvas.getContext('2d');

    if (!items.length) {
        if (modelChart) {
            modelChart.destroy();
            modelChart = null;
        }
        container.classList.add('hidden');
        return;
    }

    const metric = metricOverride || document.getElementById('modelMetric')?.value || 'calls';
    let metricLabel = 'Calls';
    if (metric === 'tokens') metricLabel = 'Tokens';
    if (metric === 'avgLatency') metricLabel = 'Avg Latency (ms)';

    const series = buildModelChartSeries(items, metric);

    if (!modelChart) {
        modelChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: series.labels,
                datasets: series.datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                scales: {
                    x: { title: { display: true, text: 'Day' }, stacked: true },
                    y: { title: { display: true, text: metricLabel }, beginAtZero: true, stacked: true }
                }
            }
        });
    } else {
        // Completely replace datasets for cleaner updates
        modelChart.data.labels = series.labels;
        modelChart.data.datasets = series.datasets;
        modelChart.options.scales.y.title.text = metricLabel;
        modelChart.update('none');
    }

    container.classList.remove('hidden');
}

// Prevent multiple simultaneous loads
async function onLoadClick() {
    if (isLoading) {
        showWarning('Already loading...');
        return;
    }

    const limitInput = document.getElementById('limit');
    let limit = parseInt(limitInput.value, 10);

    if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
        limit = DEFAULT_LIMIT;
        limitInput.value = String(DEFAULT_LIMIT);
        showWarning(`Limit reset to ${DEFAULT_LIMIT}`);
    }

    const btn = document.getElementById('loadBtn');
    btn.textContent = 'Loading...';
    btn.disabled = true;
    isLoading = true;

    try {
        showInfo('Loading traces...');
        const items = await fetchTraces(limit);
        allItems = items;
        currentPage = 1;
        updateKpis(allItems);
        updateTable(allItems, currentPage, ROWS_PER_PAGE);
        updateChart(allItems);
        updateModelChart(allItems);
        showSuccess(`Loaded ${items.length} traces`);
    } catch (err) {
        showError(err.message || String(err));
        console.error('Error loading traces:', err);
    } finally {
        btn.textContent = 'Load';
        btn.disabled = false;
        isLoading = false;
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('loadBtn').addEventListener('click', onLoadClick);

    const prevBtn = document.getElementById('prevPage');
    const nextBtn = document.getElementById('nextPage');
    if (prevBtn && nextBtn) {
        prevBtn.addEventListener('click', goToPrevPage);
        nextBtn.addEventListener('click', goToNextPage);
    }

    const yMetricSelect = document.getElementById('yMetric');
    if (yMetricSelect) {
        yMetricSelect.addEventListener('change', () => updateChart(allItems));
    }

    const modelMetricSelect = document.getElementById('modelMetric');
    if (modelMetricSelect) {
        modelMetricSelect.addEventListener('change', () => updateModelChart(allItems));
    }
});
