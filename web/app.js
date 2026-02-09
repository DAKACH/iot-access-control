// ===================== Configuration =====================
const API_BASE = '';
const DEVICE_ID = 'door_01';
const CREDENTIALS = { username: 'admin', password: 'admin' };

// ===================== Global State =====================
let activityChart = null;
let autoRefreshInterval = null;
let currentLogs = [];
let currentStats = null;
let isLoggedIn = false;

// ===================== Initialize =====================
document.addEventListener('DOMContentLoaded', () => {
  checkSession();
  initTheme();
});

// ===================== Authentication =====================
function checkSession() {
  const session = sessionStorage.getItem('isLoggedIn');
  if (session === 'true') {
    showDashboard();
  } else {
    showLogin();
  }
}

function handleLogin(event) {
  event.preventDefault();

  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');

  if (username === CREDENTIALS.username && password === CREDENTIALS.password) {
    sessionStorage.setItem('isLoggedIn', 'true');
    errorEl.textContent = '';
    showDashboard();
    showNotification('Bienvenue, Admin!', 'success');
  } else {
    errorEl.textContent = '❌ Identifiants incorrects';
    document.getElementById('login-password').value = '';
  }
}

function handleLogout() {
  sessionStorage.removeItem('isLoggedIn');
  stopAutoRefresh();
  showLogin();
  showNotification('Déconnexion réussie', 'info');
}

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
  isLoggedIn = false;
}

function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  isLoggedIn = true;

  // Initialize dashboard components
  initChart();
  initHeatmap();
  loadData();
  startAutoRefresh();
}

// ===================== Theme Management =====================
function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  applyTheme(savedTheme);

  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', toggleTheme);
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  localStorage.setItem('theme', newTheme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.querySelector('.theme-icon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '🌙' : '☀️';
  }

  if (activityChart) {
    updateChartTheme(theme);
  }
}

function updateChartTheme(theme) {
  const textColor = theme === 'dark' ? '#9ca3af' : '#64748b';
  const gridColor = theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  activityChart.options.scales.x.ticks.color = textColor;
  activityChart.options.scales.y.ticks.color = textColor;
  activityChart.options.scales.x.grid.color = gridColor;
  activityChart.options.scales.y.grid.color = gridColor;
  activityChart.options.plugins.legend.labels.color = textColor;
  activityChart.update('none');
}

// ===================== Chart Initialization =====================
function initChart() {
  const canvas = document.getElementById('activityChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const textColor = theme === 'dark' ? '#9ca3af' : '#64748b';
  const gridColor = theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  if (activityChart) {
    activityChart.destroy();
  }

  activityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Accès Autorisés',
          data: [],
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.15)',
          borderWidth: 3,
          tension: 0.4,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#10b981'
        },
        {
          label: 'Accès Refusés',
          data: [],
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239, 68, 68, 0.15)',
          borderWidth: 3,
          tension: 0.4,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#ef4444'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: textColor,
            padding: 20,
            font: { size: 12, weight: '600' },
            usePointStyle: true,
            pointStyle: 'circle'
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: '#fff',
          bodyColor: '#e5e7eb',
          padding: 12,
          cornerRadius: 10
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1, color: textColor, font: { size: 11 } },
          grid: { color: gridColor }
        },
        x: {
          ticks: { color: textColor, font: { size: 11 }, maxRotation: 0 },
          grid: { color: gridColor }
        }
      }
    }
  });
}

// ===================== Heatmap =====================
function initHeatmap() {
  const grid = document.getElementById('heatmap-grid');
  if (!grid) return;

  const days = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  grid.innerHTML = '';

  for (let day = 0; day < 7; day++) {
    const dayLabel = document.createElement('div');
    dayLabel.className = 'heatmap-day-label';
    dayLabel.textContent = days[day];
    grid.appendChild(dayLabel);

    for (let hour = 0; hour < 24; hour++) {
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell level-0';
      cell.dataset.day = day;
      cell.dataset.hour = hour;
      cell.title = `${days[day]} ${hour}h: 0`;
      grid.appendChild(cell);
    }
  }
}

function updateHeatmap(logs) {
  document.querySelectorAll('.heatmap-cell').forEach(cell => {
    cell.className = 'heatmap-cell level-0';
  });

  const counts = {};
  const days = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  logs.forEach(log => {
    const date = new Date(log.time);
    const dayIndex = (date.getDay() + 6) % 7;
    const hour = date.getHours();
    const key = `${dayIndex}-${hour}`;
    counts[key] = (counts[key] || 0) + 1;
  });

  const maxCount = Math.max(...Object.values(counts), 1);

  Object.entries(counts).forEach(([key, count]) => {
    const [day, hour] = key.split('-');
    const cell = document.querySelector(`.heatmap-cell[data-day="${day}"][data-hour="${hour}"]`);
    if (cell) {
      const level = Math.min(5, Math.ceil((count / maxCount) * 5));
      cell.className = `heatmap-cell level-${level}`;
      cell.title = `${days[day]} ${hour}h: ${count}`;
    }
  });
}

// ===================== Data Loading =====================
async function loadData() {
  if (!isLoggedIn) return;

  try {
    updateStatus('online', 'Connecté');

    const range = document.getElementById('filter-range')?.value || '24h';
    const limit = document.getElementById('filter-limit')?.value || '25';

    const [stats, logs, security] = await Promise.all([
      fetch(`${API_BASE}/api/stats?range=${range}`).then(r => r.json()),
      fetch(`${API_BASE}/api/logs?limit=${limit}&range=${range}`).then(r => r.json()),
      fetch(`${API_BASE}/api/security?range=${range}`).then(r => r.json())
    ]);

    currentStats = stats;
    currentLogs = logs;

    updateStats(stats);
    updateChart(stats.timeseries || []);
    updateLogsTable(applyClientFilters(logs));
    updateHeatmap(logs);
    updateSecurityDashboard(security);

    if (logs.length > 0) {
      const latest = logs[0];
      const doorStatus = latest.result === 'GRANTED' ? 'Ouverte' : 'Fermée';
      document.getElementById('door-status').textContent = doorStatus;
      document.getElementById('last-update').textContent = formatTime(latest.time);
    }

  } catch (error) {
    console.error('Erreur:', error);
    updateStatus('offline', 'Déconnecté');
  }
}

// ===================== Security Dashboard =====================
function updateSecurityDashboard(security) {
  if (!security) return;

  // Update Risk Score Gauge
  const riskScore = security.risk_score || 0;
  const riskLevel = security.risk_level || 'LOW';
  const failureRate = security.failure_rate || 0;

  // Update gauge fill (circumference = 2 * PI * 50 ≈ 314)
  const gaugeFill = document.getElementById('risk-gauge-fill');
  if (gaugeFill) {
    const circumference = 314;
    const offset = circumference - (riskScore / 100) * circumference;
    gaugeFill.style.strokeDasharray = circumference;
    gaugeFill.style.strokeDashoffset = offset;

    // Color based on risk level
    if (riskScore >= 70) {
      gaugeFill.style.stroke = '#ef4444';
    } else if (riskScore >= 50) {
      gaugeFill.style.stroke = '#f59e0b';
    } else if (riskScore >= 25) {
      gaugeFill.style.stroke = '#eab308';
    } else {
      gaugeFill.style.stroke = '#10b981';
    }
  }

  // Update risk score number
  const riskScoreEl = document.getElementById('risk-score');
  if (riskScoreEl) {
    animateNumber('risk-score', riskScore);
  }

  // Update risk badge
  const riskBadge = document.getElementById('risk-badge');
  if (riskBadge) {
    riskBadge.textContent = riskLevel;
    riskBadge.className = 'risk-badge';
    if (riskLevel === 'CRITICAL') riskBadge.classList.add('critical');
    else if (riskLevel === 'HIGH') riskBadge.classList.add('high');
    else if (riskLevel === 'MEDIUM') riskBadge.classList.add('medium');
    else riskBadge.classList.add('low');
  }

  // Update risk level text
  const riskLevelText = document.getElementById('risk-level-text');
  if (riskLevelText) {
    const levelNames = {
      'CRITICAL': 'Niveau: Critique ⚠️',
      'HIGH': 'Niveau: Élevé',
      'MEDIUM': 'Niveau: Moyen',
      'LOW': 'Niveau: Faible ✅'
    };
    riskLevelText.textContent = levelNames[riskLevel] || `Niveau: ${riskLevel}`;
  }

  // Update failure rate with warning
  const failureRateEl = document.getElementById('failure-rate');
  if (failureRateEl) {
    failureRateEl.textContent = `${failureRate}%`;
    if (failureRate > 30) {
      failureRateEl.classList.add('warning');
      failureRateEl.parentElement.classList.add('warning');
    } else {
      failureRateEl.classList.remove('warning');
      failureRateEl.parentElement.classList.remove('warning');
    }
  }

  // Update brute force count
  const bruteForceEl = document.getElementById('brute-force-count');
  if (bruteForceEl) {
    bruteForceEl.textContent = security.brute_force_uids?.length || 0;
  }

  // Update suspicious activity count
  const suspiciousEl = document.getElementById('suspicious-count');
  if (suspiciousEl) {
    suspiciousEl.textContent = security.suspicious_hours_count || 0;
  }

  // Update alerts list
  const alertsList = document.getElementById('alerts-list');
  if (alertsList) {
    const alerts = security.alerts || [];

    if (alerts.length === 0) {
      alertsList.innerHTML = `
        <div class="alert-item success">
          <span class="alert-icon">✅</span>
          <span class="alert-text">Aucune alerte - Système sécurisé</span>
        </div>
      `;
    } else {
      alertsList.innerHTML = alerts.map(alert => {
        const severityClass = alert.severity === 'HIGH' ? 'danger' :
          alert.severity === 'MEDIUM' ? 'warning' : 'info';
        const icon = alert.severity === 'HIGH' ? '🚨' :
          alert.severity === 'MEDIUM' ? '⚠️' : 'ℹ️';
        return `
          <div class="alert-item ${severityClass}">
            <span class="alert-icon">${icon}</span>
            <div class="alert-content">
              <span class="alert-text">${alert.message}</span>
              <span class="alert-type">${alert.type.replace(/_/g, ' ')}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }
}

// ===================== Filters =====================
function applyFilters() {
  loadData();
  showNotification('Filtres appliqués', 'success');
}

function applyClientFilters(logs) {
  const deviceFilter = document.getElementById('filter-device')?.value || '';
  const resultFilter = document.getElementById('filter-result')?.value || '';

  return logs.filter(log => {
    if (deviceFilter && log.device_id !== deviceFilter) return false;
    if (resultFilter && log.result !== resultFilter) return false;
    return true;
  });
}

// ===================== Statistics Update =====================
function updateStats(stats) {
  const total = stats.total || 0;
  const granted = stats.granted || 0;
  const denied = stats.denied || 0;

  const grantedPercent = total > 0 ? Math.round((granted / total) * 100) : 0;
  const deniedPercent = total > 0 ? Math.round((denied / total) * 100) : 0;

  animateNumber('total-count', total);
  animateNumber('granted-count', granted);
  animateNumber('denied-count', denied);

  document.getElementById('granted-percent').textContent = `${grantedPercent}%`;
  document.getElementById('denied-percent').textContent = `${deniedPercent}%`;
}

function animateNumber(elementId, targetValue) {
  const element = document.getElementById(elementId);
  if (!element) return;

  const currentValue = parseInt(element.textContent) || 0;
  if (currentValue === targetValue) return;

  const duration = 400;
  const steps = 15;
  const stepValue = (targetValue - currentValue) / steps;
  const stepDuration = duration / steps;

  let current = currentValue;
  let step = 0;

  const interval = setInterval(() => {
    step++;
    current += stepValue;

    if (step >= steps) {
      element.textContent = targetValue;
      clearInterval(interval);
    } else {
      element.textContent = Math.round(current);
    }
  }, stepDuration);
}

// ===================== Chart Update =====================
function updateChart(timeseries) {
  if (!activityChart || !timeseries) return;

  const labels = timeseries.map(t => formatTime(t.time, true));
  const grantedData = timeseries.map(t => t.granted || 0);
  const deniedData = timeseries.map(t => t.denied || 0);

  activityChart.data.labels = labels;
  activityChart.data.datasets[0].data = grantedData;
  activityChart.data.datasets[1].data = deniedData;
  activityChart.update('none');
}

// ===================== Logs Table Update =====================
function updateLogsTable(logs) {
  const tbody = document.getElementById('logs-body');
  if (!tbody) return;

  if (!logs || logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 30px;">Aucune donnée</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(log => `
    <tr>
      <td>${formatTime(log.time)}</td>
      <td><code>${log.device_id || '—'}</code></td>
      <td style="font-family: monospace;">${log.uid || '—'}</td>
      <td>${formatResult(log.result)}</td>
      <td>${log.rssi ? `${log.rssi} dBm` : '—'}</td>
    </tr>
  `).join('');
}

// ===================== CSV Export =====================
function exportCSV() {
  if (!currentLogs || currentLogs.length === 0) {
    showNotification('Aucune donnée', 'error');
    return;
  }

  const headers = ['Horodatage', 'Appareil', 'UID', 'Résultat', 'WiFi'];
  const rows = currentLogs.map(log => [
    formatTime(log.time),
    log.device_id || '',
    log.uid || '',
    log.result === 'GRANTED' ? 'Autorisé' : 'Refusé',
    log.rssi ? `${log.rssi} dBm` : ''
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
  ].join('\n');

  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });

  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `access_logs_${new Date().toISOString().split('T')[0]}.csv`;
  link.click();

  showNotification('CSV téléchargé', 'success');
}

// ===================== Utilities =====================
function formatTime(isoString, shortFormat = false) {
  if (!isoString) return '—';

  try {
    const date = new Date(isoString);

    if (shortFormat) {
      return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    return date.toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
  } catch (e) {
    return isoString;
  }
}

function formatResult(result) {
  if (result === 'GRANTED') {
    return '<span class="badge badge-success">✅ Autorisé</span>';
  } else if (result === 'DENIED') {
    return '<span class="badge badge-danger">⛔ Refusé</span>';
  }
  return '<span class="badge">' + (result || '—') + '</span>';
}

function updateStatus(status, text) {
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  if (indicator) indicator.className = `indicator ${status}`;
  if (statusText) statusText.textContent = text;
}

// ===================== Control Commands =====================
async function sendCommand(command) {
  try {
    const response = await fetch(`${API_BASE}/api/control/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, cmd: command })
    });

    if (response.ok) {
      showNotification(`Commande: ${getCommandName(command)}`, 'success');
      setTimeout(loadData, 1000);
    } else {
      showNotification('Échec', 'error');
    }
  } catch (error) {
    showNotification('Erreur connexion', 'error');
  }
}

function getCommandName(cmd) {
  const names = {
    'open': 'Ouvrir la porte',
    'lockdown_on': 'Activer Lockdown',
    'lockdown_off': 'Désactiver Lockdown',
    'buzzer_test': 'Tester buzzer'
  };
  return names[cmd] || cmd;
}

// ===================== Notifications =====================
function showNotification(message, type = 'info') {
  const colors = {
    success: 'linear-gradient(135deg, #10b981, #059669)',
    error: 'linear-gradient(135deg, #ef4444, #dc2626)',
    info: 'linear-gradient(135deg, #667eea, #764ba2)'
  };

  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed; top: 24px; left: 50%; transform: translateX(-50%) translateY(-20px);
    background: ${colors[type]}; color: white; padding: 14px 28px; border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3); z-index: 9999; font-weight: 600;
    font-size: 14px; opacity: 0; transition: all 0.3s ease;
  `;
  notification.textContent = message;
  document.body.appendChild(notification);

  requestAnimationFrame(() => {
    notification.style.opacity = '1';
    notification.style.transform = 'translateX(-50%) translateY(0)';
  });

  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transform = 'translateX(-50%) translateY(-20px)';
    setTimeout(() => notification.remove(), 300);
  }, 2500);
}

// ===================== Auto Refresh =====================
function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshInterval = setInterval(loadData, 8000); // 8 seconds
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}
