// static/app.js (완성형)
// ===============================
// ✅ 배포 시: Render 서버 주소로 변경
// const PROXY_URL = "https://decotile-server.onrender.com/api/floor/edit";
const PROXY_URL = "http://localhost:8787/api/floor/edit";

// DOM
const baseImage = document.getElementById("baseImage");
const fileInput = document.getElementById("fileInput");
const captureBtn = document.getElementById("captureBtn");
const swatches = document.getElementById("swatches");
const statusHint = document.getElementById("statusHint");
const centerAction = document.getElementById("centerAction");

// Actions
const btnUndo = document.getElementById("btnUndo");
const btnRedo = document.getElementById("btnRedo");
const btnReset = document.getElementById("btnReset");
const btnDownload = document.getElementById("btnDownload");

// ✅ 핵심: 업로드 원본(절대 변경 금지)
let originalImageDataUrl = "";

// ✅ 히스토리(결과 미리보기용) — “원본은 별도”, history에는 “결과 화면”만 쌓음
let history = [];
let historyIndex = -1;

let isProcessing = false;

function setStatus(text, color = "") {
  statusHint.textContent = text;
  statusHint.style.color = color || "";
}

function setButtonsEnabled(enabled) {
  [captureBtn, btnUndo, btnRedo, btnReset, btnDownload].forEach((el) => {
    if (!el) return;
    el.disabled = !enabled;
    el.style.opacity = enabled ? "1" : "0.55";
    el.style.cursor = enabled ? "pointer" : "not-allowed";
  });
}

function getMimeFromDataUrl(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(dataUrl);
  return m ? m[1] : "image/jpeg";
}

function dataUrlToBase64(dataUrl) {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("FileReader failed"));
    reader.onloadend = () => {
      const res = reader.result;
      if (typeof res !== "string") return reject(new Error("Invalid FileReader result"));
      resolve(dataUrlToBase64(res));
    };
    reader.readAsDataURL(blob);
  });
}

async function fetchTileBase64(tilePath) {
  const r = await fetch(tilePath, { cache: "no-store" });
  if (!r.ok) throw new Error(`Tile fetch failed: ${r.status} ${r.statusText}`);
  const blob = await r.blob();
  const b64 = await blobToBase64(blob);

  const mime =
    (blob.type && blob.type.startsWith("image/")) ? blob.type :
    (tilePath.toLowerCase().endsWith(".jpg") || tilePath.toLowerCase().endsWith(".jpeg")) ? "image/jpeg" :
    "image/png";

  return { tileB64: b64, tileMime: mime };
}

function setSwatchActive(btn) {
  document.querySelectorAll(".swatchCard").forEach(el => el.classList.remove("active"));
  btn.classList.add("active");
}

function setImageForView(dataUrl) {
  baseImage.src = dataUrl;
  baseImage.style.display = "block";
  centerAction.style.display = "none";
}

function pushHistory(dataUrl) {
  // 중간에서 되돌린 상태면, 이후 기록은 잘라내고 새로 쌓음
  if (historyIndex < history.length - 1) {
    history = history.slice(0, historyIndex + 1);
  }
  history.push(dataUrl);
  historyIndex = history.length - 1;
  refreshHistoryButtons();
}

function refreshHistoryButtons() {
  if (btnUndo) btnUndo.disabled = !(historyIndex > 0);
  if (btnRedo) btnRedo.disabled = !(historyIndex < history.length - 1);
  if (btnReset) btnReset.disabled = !originalImageDataUrl;
  if (btnDownload) btnDownload.disabled = !baseImage.src;
}

// -----------------------
// Upload
// -----------------------
captureBtn.onclick = () => {
  if (isProcessing) return;
  fileInput.click();
};

fileInput.onchange = async (e) => {
  let file = e.target.files?.[0];
  if (!file) return;
  if (isProcessing) return;

  setStatus("이미지 불러오는 중...");
  setButtonsEnabled(false);

  try {
    // HEIC -> JPG
    if (
      (file.name || "").toLowerCase().endsWith(".heic") ||
      (file.type || "").toLowerCase().includes("heic") ||
      (file.type || "").toLowerCase().includes("heif")
    ) {
      if (typeof heic2any === "undefined") throw new Error("heic2any 라이브러리를 찾을 수 없습니다.");
      const converted = await heic2any({ blob: file, toType: "image/jpeg" });
      const blob = Array.isArray(converted) ? converted[0] : converted;
      file = new File([blob], "photo.jpg", { type: "image/jpeg" });
    }

    const reader = new FileReader();
    reader.onerror = () => setStatus("이미지 업로드 실패", "#dc3545");
    reader.onload = (event) => {
      originalImageDataUrl = event.target.result;

      // ✅ 원본을 화면에 표시 + 히스토리 초기화
      setImageForView(originalImageDataUrl);
      history = [originalImageDataUrl];
      historyIndex = 0;
      refreshHistoryButtons();

      setStatus("아래에서 타일을 선택해 바닥을 변경하세요.");
    };
    reader.readAsDataURL(file);
  } catch (err) {
    console.error(err);
    setStatus("이미지 업로드 실패", "#dc3545");
  } finally {
    fileInput.value = "";
    setButtonsEnabled(true);
    refreshHistoryButtons();
  }
};

// -----------------------
// History buttons
// -----------------------
if (btnUndo) {
  btnUndo.onclick = () => {
    if (isProcessing) return;
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    setImageForView(history[historyIndex]);
    refreshHistoryButtons();
    setStatus("되돌렸습니다.");
  };
}
if (btnRedo) {
  btnRedo.onclick = () => {
    if (isProcessing) return;
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    setImageForView(history[historyIndex]);
    refreshHistoryButtons();
    setStatus("다시 적용했습니다.");
  };
}
if (btnReset) {
  btnReset.onclick = () => {
    if (isProcessing) return;
    if (!originalImageDataUrl) return;
    setImageForView(originalImageDataUrl);
    history = [originalImageDataUrl];
    historyIndex = 0;
    refreshHistoryButtons();
    setStatus("원본으로 되돌렸습니다.");
  };
}
if (btnDownload) {
  btnDownload.onclick = async () => {
    if (!baseImage.src) return;

    try {
      const a = document.createElement("a");
      a.href = baseImage.src;
      a.download = `decotile_${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setStatus("이미지를 저장했습니다.", "#28a745");
    } catch (e) {
      console.error(e);
      setStatus("저장 실패", "#dc3545");
    }
  };
}

// -----------------------
// Tile click => ALWAYS use original input
// -----------------------
swatches.onclick = async (e) => {
  const btn = e.target.closest(".swatchCard");
  if (!btn) return;

  if (!originalImageDataUrl) {
    setStatus("먼저 사진을 업로드해주세요.", "#dc3545");
    return;
  }
  if (isProcessing) return;

  const tilePath = btn.dataset.img;
  const tileName = btn.dataset.name;
  if (!tilePath || !tileName) return;

  setSwatchActive(btn);
  setStatus(`[${tileName}]로 바닥 변경 중...`, "#007bff");
  isProcessing = true;
  setButtonsEnabled(false);

  try {
    // ✅ 중요: 항상 원본 기준으로 전송 (연속 편집 금지)
    const userMime = getMimeFromDataUrl(originalImageDataUrl);
    const userB64 = dataUrlToBase64(originalImageDataUrl);
    const { tileB64, tileMime } = await fetchTileBase64(tilePath);

    const resp = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userMime, userB64, tileMime, tileB64, tileName })
    });

    const data = await resp.json();
    console.log("Proxy response:", data);

    // 서버가 200으로 error 내려주는 경우 방어
    if (data?.error && !data?.imageB64) {
      if (data.error === "NO_IMAGE") {
        setStatus("AI가 이미지 결과를 주지 않았습니다. (NO_IMAGE)", "#dc3545");
        return;
      }
      if (data.error === "IMAGE_TOO_SMALL") {
        setStatus(`이미지 결과가 너무 짧습니다. (${data.length})`, "#dc3545");
        return;
      }
      setStatus(`서버 오류: ${data.error}`, "#dc3545");
      return;
    }

    if (data.imageB64) {
      // ✅ 너무 짧으면 적용하지 않음
      if (data.imageB64.length < 10000) {
        setStatus(`이미지 데이터가 너무 짧습니다: ${data.imageB64.length}`, "#dc3545");
        return;
      }

      const resultDataUrl = `data:${data.mime || "image/png"};base64,${data.imageB64}`;

      // 화면 표시 + 히스토리에 기록
      setImageForView(resultDataUrl);
      pushHistory(resultDataUrl);

      setStatus(`${tileName} 시공 완료!`, "#28a745");
      return;
    }

    setStatus(`오류: ${data.error || "Unknown error"}`, "#dc3545");
  } catch (err) {
    console.error(err);
    setStatus(`오류: ${err.message || "서버 오류"}`, "#dc3545");
  } finally {
    isProcessing = false;
    setButtonsEnabled(true);
    refreshHistoryButtons();
  }
};

// init
refreshHistoryButtons();