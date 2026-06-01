let currentAnalysis = null;
let socket = null;

// Инициализация WebSocket
function initSocket() {
  socket = io();

  socket.on("connect", () => {
    console.log("Connected to server");
  });

  socket.on("status", (data) => {
    updateLoadingText(data.message);

    // Если есть прогресс загрузки страниц, показываем его
    if (data.progress && data.stage === "fetching_orders") {
      const progressBar = document.getElementById("progress-bar");
      progressBar.style.width = `${data.progress}%`;

      const progressText = document.getElementById("progress-text");
      progressText.textContent = `Загрузка страниц: ${data.progress}%`;
    }

    // Если есть детали о загрузке страниц, показываем их
    if (data.details && data.stage === "fetching_orders") {
      const loadingDetails = document.getElementById("loading-details");
      loadingDetails.innerHTML = `
                        <div>📑 Страница: ${data.details.currentPage}${
        data.details.totalPages > 1 ? ` из ${data.details.totalPages}` : ""
      }</div>
                        <div>📦 Загружено заказов: ${
                          data.details.loadedOrders
                        }${
        data.details.totalOrders > 0 ? ` из ${data.details.totalOrders}` : ""
      }</div>
                    `;
    }
  });

  socket.on("progress", (data) => {
    updateProgress(data);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected from server");
  });
}

async function analyzeOilUsage() {
  const year = document.getElementById("year").value;
  const month = document.getElementById("month").value;
  const oilFilter = document.getElementById("oilFilter").value;
  // Проверка что год выбран
  if (!year) {
    showError('Пожалуйста, выберите год или "Весь период"');
    return;
  }

  showLoading();
  hideResults();
  hideError();
  resetProgress();

  try {
    const params = new URLSearchParams();
    params.append("year", year);
    if (month) {
      params.append("month", month);
    }
    if (oilFilter) {
      params.append("oilFilter", oilFilter);
    }

    const response = await fetch(`/api/oil-usage?${params}`, {
      headers: {
        "socket-id": socket.id,
      },
    });

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || "Произошла ошибка при анализе");
    }

    currentAnalysis = data;
    displayResults(data);
    hideLoading();
  } catch (error) {
    console.error("Error:", error);
    showError(`Ошибка: ${error.message}`);
    hideLoading();
  }
}

function updateProgress(data) {
  const progressBar = document.getElementById("progress-bar");
  const progressText = document.getElementById("progress-text");
  const loadingDetails = document.getElementById("loading-details");

  progressBar.style.width = `${data.percentage}%`;

  progressText.textContent = `${data.percentage}% (${data.processed}/${data.total})`;

  const errorInfo =
    data.errors > 0
      ? `<div style="color: #e53e3e;">⚠️ Ошибок: ${data.errors}</div>`
      : "";

  let oilBreakdownInfo = "";
  if (data.oilBreakdown && data.oilBreakdown.length > 0) {
    oilBreakdownInfo = '<div style="margin-top: 10px; font-size: 13px;">';
    data.oilBreakdown.forEach((oil) => {
      oilBreakdownInfo += `<div>🛢️ ${oil.name}: ${oil.quantity} л (${oil.orders} заказов)</div>`;
    });
    oilBreakdownInfo += "</div>";
  }

  loadingDetails.innerHTML = `
                <div>📦 Пакет: ${data.currentBatch}/${data.totalBatches}</div>
                <div>🛢️ Найдено заказов с маслом: ${data.foundOrders}</div>
                <div>📊 Общий объем: ${data.totalQuantity} л</div>
                ${errorInfo}
                ${oilBreakdownInfo}
            `;
}
function filterByOilType(data, selectedOilId) {
  if (!selectedOilId) {
    return data;
  }

  console.log("🔍 Filtering for oilId:", selectedOilId);
  console.log("Total orders before filter:", data.ordersWithOil.length);

  // Приводим selectedOilId к строке для корректного поиска
  const oilIdStr = selectedOilId.toString();

  // Фильтруем заказы, оставляя только те, где есть выбранное масло
  const filteredOrders = data.ordersWithOil.filter((order) => {
    return order.oilsByType && order.oilsByType[oilIdStr] > 0;
  });

  console.log("Total orders after filter:", filteredOrders.length);

  // Пересчитываем статистику для выбранного масла
  let totalQuantity = 0;
  filteredOrders.forEach((order) => {
    totalQuantity += order.oilsByType[oilIdStr] || 0;
  });

  return {
    ...data,
    ordersWithOil: filteredOrders,
    totalQuantity: totalQuantity,
    processedOrders: data.processedOrders,
    selectedOilId: oilIdStr,
    selectedOilName: data.oilBreakdown[oilIdStr]?.name || "Unknown",
  };
}
function resetProgress() {
  const progressBar = document.getElementById("progress-bar");
  const progressText = document.getElementById("progress-text");
  const loadingDetails = document.getElementById("loading-details");

  progressBar.style.width = "0%";
  progressText.textContent = "";
  loadingDetails.innerHTML = "";
}

function updateLoadingText(text) {
  document.getElementById("loading-text").textContent = text;
}

function displayResults(data) {
  // Применяем фильтр по типу масла если выбран
  const selectedOilId = document.getElementById("oilFilter").value;
  console.log("🔍 displayResults - selectedOilId:", selectedOilId);
  console.log(
    "🔍 displayResults - data.ordersWithOil.length before:",
    data.ordersWithOil.length,
  );

  if (selectedOilId) {
    console.log("🔍 Calling filterByOilType...");
    data = filterByOilType(data, selectedOilId);
  }

  console.log(
    "🔍 displayResults - data.ordersWithOil.length after:",
    data.ordersWithOil.length,
  );

  // Обновляем сводку - с проверкой наличия элементов
  const totalQtyEl = document.getElementById("total-quantity");
  const ordersOilEl = document.getElementById("orders-with-oil");
  const processedEl = document.getElementById("processed-orders");
  const periodEl = document.getElementById("period");

  if (totalQtyEl) totalQtyEl.textContent = `${data.totalQuantity.toFixed(2)} л`;
  if (ordersOilEl) ordersOilEl.textContent = data.ordersWithOil.length;
  if (processedEl) processedEl.textContent = data.processedOrders;
  if (periodEl) periodEl.textContent = data.period;

  // Показываем ошибки если они есть
  const errorsCard = document.getElementById("errors-card");
  const errorsCount = document.getElementById("errors-count");
  if (data.errors && data.errors > 0) {
    errorsCard.style.display = "block";
    errorsCount.textContent = data.errors;
    errorsCard.style.background =
      "linear-gradient(135deg, #ff6b6b 0%, #ee5a52 100%)";
  } else {
    errorsCard.style.display = "none";
  }

  // Заполняем таблицу заказов
  const tbody = document.getElementById("orders-tbody");
  tbody.innerHTML = "";

  data.ordersWithOil.forEach((order) => {
    const row = document.createElement("tr");
    const createdDate = new Date(order.createdAt).toLocaleDateString("ru-RU");

    // Подсчитываем примерную стоимость масла
    let totalCost = 0;
    if (order.items && order.items.length > 0) {
      totalCost = order.items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0,
      );
    }

    // Формируем информацию о типах масла в заказе
    let oilTypesInfo = "";
    if (order.oilsByType) {
      const oilTypes = [];
      Object.keys(order.oilsByType).forEach((oilId) => {
        if (order.oilsByType[oilId] > 0) {
          const oilName = getOilShortName(oilId);
          const color = getOilColor(oilId);
          oilTypes.push(
            `<span style="color: ${color}; font-weight: bold;">${oilName}: ${order.oilsByType[
              oilId
            ].toFixed(2)}л</span>`,
          );
        }
      });
      oilTypesInfo = oilTypes.join("<br>");
    }

    row.innerHTML = `
                    <td>${order.orderId}</td>
                    <td>${order.orderLabel || "-"}</td>
                    <td>${createdDate}</td>
                    <td><strong>${order.totalQuantity.toFixed(
                      2,
                    )} л</strong></td>
                    <td style="font-size: 12px; line-height: 1.4;">${oilTypesInfo}</td>
                    <td>${order.status}</td>
                    <td>${
                      totalCost > 0 ? totalCost.toFixed(2) + " грн" : "-"
                    }</td>
                `;
    tbody.appendChild(row);
  });

  // Показываем дополнительную информацию о периоде
  let periodInfo = "";
  if (data.dateRange) {
    const startDate = new Date(data.dateRange.start).toLocaleDateString(
      "ru-RU",
    );
    const endDate = new Date(data.dateRange.end).toLocaleDateString("ru-RU");
    periodInfo = `<div style="margin-top: 10px; font-size: 14px; color: #666;">
                    📅 Точный период: ${startDate} - ${endDate}
                </div>`;
  }

  // Добавляем информацию после таблицы
  const ordersDetails = document.getElementById("orders-details");
  const existingInfo = ordersDetails.querySelector(".period-info");
  if (existingInfo) {
    existingInfo.remove();
  }
  if (periodInfo) {
    const infoDiv = document.createElement("div");
    infoDiv.className = "period-info";
    infoDiv.innerHTML = periodInfo;
    ordersDetails.appendChild(infoDiv);
  }

  // Показать результаты
  document.getElementById("results").style.display = "block";
}

// Вспомогательные функции для получения информации о масле
function getOilShortName(oilId) {
  const oilMap = {
    29400883: "5W30",
    30262242: "5W30 DIESEL",
    29400905: "5W40",
    39724113: "75W90",
  };
  return oilMap[oilId.toString()] || "Unknown";
}

function getOilColor(oilId) {
  const colorMap = {
    29400883: "#4CAF50",
    30262242: "#2196F3",
    29400905: "#FF9800",
    39724113: "#9C27B0",
  };
  return colorMap[oilId.toString()] || "#666";
}

function showLoading() {
  document.getElementById("loading").style.display = "block";
  document.querySelector(".btn").disabled = true;
}

function hideLoading() {
  document.getElementById("loading").style.display = "none";
  document.querySelector(".btn").disabled = false;
}

function showResults() {
  document.getElementById("results").style.display = "block";
}

function hideResults() {
  document.getElementById("results").style.display = "none";
}

function showError(message) {
  const errorDiv = document.getElementById("error");
  errorDiv.textContent = message;
  errorDiv.style.display = "block";
}

function hideError() {
  document.getElementById("error").style.display = "none";
}

// Автоматически устанавливаем текущий месяц и инициализируем сокет
document.addEventListener("DOMContentLoaded", function () {
  // Генерируем список годов динамически
  // Генерируем список годов динамически
  const yearSelect = document.getElementById("year");
  const currentYear = new Date().getFullYear();

  // Добавляем опцию "Весь период"
  const allPeriodOption = document.createElement("option");
  allPeriodOption.value = "all";
  allPeriodOption.textContent = "Весь период";
  yearSelect.appendChild(allPeriodOption);

  // Добавляем текущий год и предыдущие 5 лет
  for (let year = currentYear; year >= currentYear - 5; year--) {
    const option = document.createElement("option");
    option.value = year;
    option.textContent = year;
    yearSelect.appendChild(option);
  }

  // Устанавливаем текущий год по умолчанию
  yearSelect.value = currentYear;

  // Устанавливаем текущий месяц
  const currentMonth = new Date().getMonth() + 1;
  document.getElementById("month").value = currentMonth;

  // Инициализируем WebSocket
  initSocket();
});
