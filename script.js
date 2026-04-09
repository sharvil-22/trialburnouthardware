/* ─── HARDWARE: Arduino Pulse Sensor Integration ─── */
let serialPort = null;
let serialReader = null;

async function connectHardware() {
  try {
    // Request user to select the Arduino port
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });   // Must match Arduino code

    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();
    serialReader = reader;

    document.getElementById('hardwareStatus').innerHTML = 
      '✅ Pulse Sensor Connected • Live BPM streaming';

    // Read incoming data from Arduino
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      if (value && value.includes("BPM:")) {
        const bpm = parseInt(value.split("BPM:")[1].trim());
        if (!isNaN(bpm) && bpm > 40 && bpm < 200) {
          // Auto-fill the new Heart Rate field
          const hrInput = document.getElementById('heartRate');
          if (hrInput) hrInput.value = bpm;
          
          console.log(`🔴 Live BPM received: ${bpm}`);
        }
      }
    }
  } catch (err) {
    console.error("Hardware connection error:", err);
    const status = document.getElementById('hardwareStatus');
    if (status) status.innerHTML = '❌ Connection failed. Make sure Arduino is plugged in and Serial Monitor is closed.';
  }
}
/* ─── Gemini API Key ─── */


/* ─── Encryption ─── */
function generateUserKey() {
  const fingerprint = navigator.userAgent + screen.width + screen.height + Intl.DateTimeFormat().resolvedOptions().timeZone;
  return CryptoJS.SHA256(fingerprint).toString().substring(0, 32);
}

function encryptData(data) {
  const key = generateUserKey();
  return CryptoJS.AES.encrypt(JSON.stringify(data), key).toString();
}

function decryptData(ciphertext) {
  try {
    const key = generateUserKey();
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
  } catch (e) {
    return [];
  }
}

function saveData(data) {
  localStorage.setItem("burnoutData", encryptData(data));
}

function loadData() {
  const raw = localStorage.getItem("burnoutData");
  if (!raw) return [];
  try {
    // Try decrypt first (encrypted data)
    return decryptData(raw);
  } catch {
    // If old plain data exists, migrate it
    try { return JSON.parse(raw); } catch { return []; }
  }
}

/* ─── Slider sync ─── */
function syncField(fieldId, rangeId) {
  document.getElementById(fieldId).value = document.getElementById(rangeId).value;
}
function syncRange(fieldId, rangeId) {
  document.getElementById(rangeId).value = document.getElementById(fieldId).value;
}

/* ─── Adaptive Weights ─── */
const DEFAULT_WEIGHTS = {
  sleep: 30,
  study: 25,
  assignment: 25,
  screen: 25,
  stress: 30
};

function getAdaptiveWeights() {
  const data = loadData();

  // Need at least 5 entries to start adapting
  if (data.length < 5) return DEFAULT_WEIGHTS;

  const last = data.slice(-10); // use last 10 entries

  // Calculate how much each factor varies on high-score days vs low-score days
  const highDays = last.filter(e => e.score > 50);
  const lowDays  = last.filter(e => e.score <= 50);

  if (highDays.length === 0 || lowDays.length === 0) return DEFAULT_WEIGHTS;

  const avg = (arr, key) => arr.reduce((s, e) => s + (e[key] || 0), 0) / arr.length;

  const diff = {
    sleep:      avg(highDays, 'sleep')      - avg(lowDays, 'sleep'),      // negative = more sleep on low days (good)
    study:      avg(highDays, 'study')      - avg(lowDays, 'study'),
    assignment: avg(highDays, 'assignment') - avg(lowDays, 'assignment'),
    screen:     avg(highDays, 'screen')     - avg(lowDays, 'screen'),
    stress:     avg(highDays, 'stress')     - avg(lowDays, 'stress'),
  };

  // Build weights — bigger difference = bigger impact on your burnout
  const weights = { ...DEFAULT_WEIGHTS };
  const factors = ['study', 'assignment', 'screen', 'stress'];

  factors.forEach(f => {
    if (diff[f] > 2)       weights[f] = Math.min(DEFAULT_WEIGHTS[f] + 10, 40);
    else if (diff[f] > 1)  weights[f] = DEFAULT_WEIGHTS[f] + 5;
    else if (diff[f] < 0)  weights[f] = Math.max(DEFAULT_WEIGHTS[f] - 5, 10);
  });

  // Sleep is inverse — more sleep on high days = sleep isn't the issue
  if (diff.sleep > 1)       weights.sleep = Math.max(DEFAULT_WEIGHTS.sleep - 5, 10);
  else if (diff.sleep < -1) weights.sleep = Math.min(DEFAULT_WEIGHTS.sleep + 10, 40);

  return weights;
}

/* ─── LLM Explainability ─── */
async function getAIExplanation(inputs, score, risk, history) {

  // Calculate personal averages from history for context
  const last7 = history.slice(-7);
  const avgScore  = last7.length ? Math.round(last7.reduce((s,e) => s + e.score, 0) / last7.length) : null;
  const avgSleep  = last7.length ? (last7.reduce((s,e) => s + (e.sleep  || 0), 0) / last7.length).toFixed(1) : null;
  const avgStress = last7.length ? (last7.reduce((s,e) => s + (e.stress || 0), 0) / last7.length).toFixed(1) : null;

  const historyContext = avgScore !== null
    ? `The user's 7-day averages are: burnout score ${avgScore}/120, sleep ${avgSleep} hrs, stress ${avgStress}/10.`
    : `This is one of the user's first entries, so no historical average is available yet.`;

  const prompt = `
You are a burnout analysis assistant for a student health app. Based on the data below, write a short personalized explanation (2-3 sentences max) telling the student:
1. What is driving their burnout risk today
2. One specific actionable suggestion based on their worst factor

Today's data:
- Burnout Score: ${score}/120
- Risk Level: ${risk}
- Sleep: ${inputs.sleep} hours
- Study Hours: ${inputs.study} hours
- Assignment Load: ${inputs.assignment}/5
- Screen Time: ${inputs.screen} hours
- Stress Level: ${inputs.stress}/10
- Session: ${inputs.session}

${historyContext}

Keep the tone supportive, specific, and concise. Do not use bullet points. Speak directly to the student.
  `.trim();

  try {
    await new Promise(r => setTimeout(r, 1000));
    const res = await fetch(
      `https://api.groq.com/openai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GEMINI_API_KEY}`
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt.trim() }],
          max_tokens: 150
        })
      }
    );
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    return null; // fallback to hardcoded message if API fails
  }
}

/* ─── Analyze ─── */
async function analyze() {
  let study      = +document.getElementById("study").value || 0;
  let sleep      = +document.getElementById("sleep").value || 0;
  let assignment = +document.getElementById("assignment").value || 0;
  let screen     = +document.getElementById("screen").value || 0;
  let stress     = +document.getElementById("stress").value || 0;
  let session    = document.getElementById("session").value;
  let heartRate  = +document.getElementById("heartRate").value || 72;
  /* ─── Input Validation ─── */
  const msg = document.getElementById("message");
  if (sleep < 1 || sleep > 10) {
    msg.style.color = "var(--high)";
    msg.innerText = "⚠ Sleep hours must be between 1 and 10.";
    setTimeout(() => { msg.innerText = ""; msg.style.color = "var(--low)"; }, 3000);
    return;
  }
  if (study < 0 || study > 12) {
    msg.style.color = "var(--high)";
    msg.innerText = "⚠ Study hours must be between 0 and 12.";
    setTimeout(() => { msg.innerText = ""; msg.style.color = "var(--low)"; }, 3000);
    return;
  }
  if (assignment < 0 || assignment > 5) {
    msg.style.color = "var(--high)";
    msg.innerText = "⚠ Assignment load must be between 0 and 5.";
    setTimeout(() => { msg.innerText = ""; msg.style.color = "var(--low)"; }, 3000);
    return;
  }
  if (screen < 0 || screen > 12) {
    msg.style.color = "var(--high)";
    msg.innerText = "⚠ Screen time must be between 0 and 12.";
    setTimeout(() => { msg.innerText = ""; msg.style.color = "var(--low)"; }, 3000);
    return;
  }
  if (stress < 1 || stress > 10) {
    msg.style.color = "var(--high)";
    msg.innerText = "⚠ Stress level must be between 1 and 10.";
    setTimeout(() => { msg.innerText = ""; msg.style.color = "var(--low)"; }, 3000);
    return;
  }

  const w = getAdaptiveWeights();
  let score = 0;
  if (sleep <= 4) score += w.sleep; else if (sleep == 5) score += w.sleep * 0.67; else if (sleep == 6) score += w.sleep * 0.33;
  if (study > 10) score += w.study; else if (study >= 9) score += w.study * 0.8; else if (study >= 7) score += w.study * 0.4;
  if (assignment >= 4) score += w.assignment; else if (assignment == 3) score += w.assignment * 0.6; else if (assignment == 2) score += w.assignment * 0.4;
  if (screen > 10) score += w.screen; else if (screen >= 8) score += w.screen * 0.8; else if (screen >= 5) score += w.screen * 0.4;
  if (stress >= 9) score += w.stress; else if (stress >= 7) score += w.stress * 0.67; else if (stress >= 4) score += w.stress * 0.33;
  score = Math.round(score);
  if (stress >= 9) score += w.stress; else if (stress >= 7) score += w.stress * 0.67; else if (stress >= 4) score += w.stress * 0.33;

  // Heart Rate Scoring (physiological input from Arduino)
  if (heartRate >= 100)      score += 30;
  else if (heartRate >= 85)  score += 20;
  else if (heartRate >= 75)  score += 10;

  score = Math.round(score);
  let risk = "Low";
  if (score > 70) risk = "High";
  else if (score > 35) risk = "Moderate";

  let probability = Math.round((score / 120) * 100);
  let csi = (score / 120 * 10).toFixed(1);

  /* Update UI */
  document.getElementById("score").innerText = score;
  document.getElementById("csi").innerText   = csi;
  document.getElementById("percentage").innerText = probability + "%";

  updateRing(probability, risk);
  updateRiskBadge(risk);

  // Show loading text while waiting for AI
  const recBox = document.getElementById("recommendation");
  recBox.innerText = "✦ Analyzing your data...";
  recBox.style.borderLeftColor = "var(--accent)";

  // Call Gemini
  const history = loadData();
  const aiText = await getAIExplanation({ sleep, study, assignment, screen, stress, session }, score, risk, history);

  if (aiText) {
    recBox.innerText = aiText;
    recBox.style.borderLeftColor = risk === "Low" ? "var(--low)" : risk === "Moderate" ? "var(--mid)" : "var(--high)";
  } else {
    giveRecommendation(risk); // fallback to hardcoded if API fails or offline
  }

  /* Save */
  let data = loadData();
  data.push({ datetime: new Date().toISOString(), score, risk, session, sleep, study, assignment, screen, stress, heartRate });   m  
  saveData(data);

  checkTrend(data);
  updateSummary(data);
  drawChart();

  /* Flash message */
  msg.innerText = "✓ Analysis saved";
  setTimeout(() => { msg.innerText = ""; }, 2000);
}

/* ─── Ring ─── */
function updateRing(percent, risk) {
  const circle = document.querySelector(".ring-progress");
  if (!circle) return;
  const r = 50;
  const circumference = 2 * Math.PI * r;
  circle.style.strokeDasharray  = circumference;
  circle.style.strokeDashoffset = circumference - (percent / 100) * circumference;
  const colors = { Low: "#22d98a", Moderate: "#f5a623", High: "#f75a5a" };
  circle.style.stroke = colors[risk];
}

/* ─── Risk Badge ─── */
function updateRiskBadge(risk) {
  const badge = document.getElementById("riskBadge");
  if (!badge) return;
  badge.className = "risk-badge " + risk.toLowerCase();
  badge.innerText = "● " + risk;
}

/* ─── Recommendation ─── */
function giveRecommendation(risk) {
  const messages = {
    Low:      "Behavioral metrics indicate stable cognitive load. Keep maintaining healthy study and sleep patterns.",
    Moderate: "Early strain patterns detected. Consider reducing screen time and scheduling short recovery breaks.",
    High:     "Critical overload probability detected. Immediate rest and recovery is strongly recommended."
  };
  const el = document.getElementById("recommendation");
  if (el) {
    el.innerText = messages[risk];
    el.style.borderLeftColor = risk === "Low" ? "var(--low)" : risk === "Moderate" ? "var(--mid)" : "var(--high)";
  }
}

/* ─── Trend ─── */
function checkTrend(data) {
  if (data.length < 2) return;
  let last = data[data.length - 1].score;
  let prev = data[data.length - 2].score;

  let trendText = last > prev ? "↑ Up" : last < prev ? "↓ Down" : "→ Stable";
  const el = document.getElementById("trend");
  if (el) el.innerText = trendText;

  const warn = document.getElementById("warning");
  if (!warn) return;
  if (data.length >= 7) {
    let avg = data.slice(-7).reduce((s,e) => s + e.score, 0) / 7;
    if (last > avg + 15) {
      warn.classList.add("visible");
      return;
    }
  }
  warn.classList.remove("visible");
}

/* ─── Daily Summary ─── */
function updateSummary(data) {
  let today    = new Date().toISOString().split('T')[0];
  let todayData = data.filter(e => e.datetime.startsWith(today));
  let count    = todayData.length;
  let avg      = count > 0 ? Math.round(todayData.reduce((s,e) => s + e.score, 0) / count) : 0;

  const entriesEl     = document.getElementById("entries");
  const avgScoreEl    = document.getElementById("avgScore");
  const entriesCount  = document.getElementById("entriesCount");
  const avgScoreToday = document.getElementById("avgScoreToday");
  if (entriesEl)     entriesEl.innerText     = count;
  if (avgScoreEl)    avgScoreEl.innerText    = "Avg today: " + avg;
  if (entriesCount)  entriesCount.innerText  = count;
  if (avgScoreToday) avgScoreToday.innerText = avg || "—";
}

/* ─── Chart ─── */
let chartInstance = null;

function drawChart() {
  const data  = loadData();
  const last7 = data.slice(-7);
  const ctx   = document.getElementById("trendChart");
  if (!ctx) return;

  if (chartInstance) { chartInstance.destroy(); }

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: last7.map(e => new Date(e.datetime).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})),
      datasets: [{
        label: 'Burnout Score',
        data: last7.map(e => e.score),
        borderColor: '#4f8ef7',
        backgroundColor: 'rgba(79,142,247,0.08)',
        tension: 0.45,
        fill: true,
        pointBackgroundColor: last7.map(e =>
          e.risk === 'High' ? '#f75a5a' : e.risk === 'Moderate' ? '#f5a623' : '#22d98a'
        ),
        pointRadius: 5,
        pointHoverRadius: 7,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0e1420',
          borderColor: 'rgba(255,255,255,0.07)',
          borderWidth: 1,
          titleColor: '#6b7a99',
          bodyColor: '#e8edf5',
          padding: 10
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#3d4f6e', font: { size: 11 } }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#3d4f6e', font: { size: 11 } },
          min: 0,
          max: 120
        }
      }
    }
  });
}

/* ─── History Page ─── */
function loadHistory() {
  const data  = loadData();
  const table = document.getElementById("historyTable");
  const count = document.getElementById("recordCount");
  if (!table) return;

  if (count) count.innerText = data.length + " entr" + (data.length === 1 ? "y" : "ies");

  if (data.length === 0) {
    table.innerHTML = `
      <tr><td colspan="4">
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <p>No records yet. Go to Dashboard and analyze your first session.</p>
        </div>
      </td></tr>`;
    return;
  }

  table.innerHTML = [...data].reverse().map(e => {
    const d = new Date(e.datetime);
    const riskColors = { Low: '#22d98a', Moderate: '#f5a623', High: '#f75a5a' };
    const color = riskColors[e.risk] || '#22d98a';
    return `
    <tr>
      <td>${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</td>
      <td>${e.session}</td>
      <td><strong>${e.score}</strong></td>
      <td>
        <span style="display:inline-flex;align-items:center;gap:7px;">
          <span class="risk-dot" style="background:${color};box-shadow:0 0 6px ${color}"></span>
          <span style="color:${color};font-weight:600;">${e.risk}</span>
        </span>
      </td>
    </tr>`;
  }).join('');
}

/* ─── Init ─── */
loadHistory();
drawChart();

const savedData = loadData();
if (savedData.length > 0) {
  checkTrend(savedData);
  updateSummary(savedData);
}
/* ─── Hardware Button Setup ─── */
document.addEventListener('DOMContentLoaded', () => {
  const connectBtn = document.getElementById('connectHardware');
  if (connectBtn) {
    connectBtn.addEventListener('click', connectHardware);
  }
});

