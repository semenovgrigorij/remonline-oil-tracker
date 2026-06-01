const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// API конфигурация из переменных окружения или значения по умолчанию
const API_BASE = process.env.REMONLINE_API_BASE || "https://api.remonline.app";
const BRANCH_ID = process.env.REMONLINE_BRANCH_ID || "134397";
const TOKEN = process.env.REMONLINE_TOKEN || "275a47a9b5eb4249ad4e8d6e0c2f219b";

// Конфигурация масел для мониторинга
const OIL_PRODUCTS = {
  [process.env.OIL_5W30_SKY || 29400883]: {
    name: "5W30 SKY",
    shortName: "5W30",
    color: "#4CAF50",
  },
  [process.env.OIL_5W30_DIESEL || 30262242]: {
    name: "5W30 DIESEL Master SKY",
    shortName: "5W30 DIESEL",
    color: "#2196F3",
  },
  [process.env.OIL_5W40_SKY || 29400905]: {
    name: "5W40 SKY",
    shortName: "5W40",
    color: "#FF9800",
  },
  [process.env.OIL_75W90_SKY || 39724113]: {
    name: "75W90 SKY",
    shortName: "75W90",
    color: "#9C27B0",
  },
};

// Функция для создания headers
const getHeaders = () => ({
  accept: "application/json",
  authorization: `Bearer ${TOKEN}`,
});

// Функция для получения товаров заказа с retry логикой
async function getOrderItems(orderId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${API_BASE}/orders/${orderId}/items`, {
        method: "GET",
        headers: getHeaders(),
      });

      if (response.status === 429) {
        // Rate limit exceeded - ждем больше времени
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff, max 10 seconds
        console.log(
          `Rate limit hit for order ${orderId}, waiting ${waitTime}ms (attempt ${attempt}/${retries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const items = await response.json();
      return Array.isArray(items) ? items : [];
    } catch (error) {
      if (attempt === retries) {
        console.error(
          `Final error fetching items for order ${orderId}:`,
          error.message,
        );
        return [];
      }

      // Ждем перед повторной попыткой
      const waitTime = 1000 * attempt;
      console.log(
        `Error fetching order ${orderId}, retrying in ${waitTime}ms (attempt ${attempt}/${retries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  return [];
}

// Функция для анализа использования масла с прогрессом
async function analyzeOilUsage(orders, socketId = null) {
  const results = {
    totalQuantity: 0,
    ordersWithOil: [],
    processedOrders: 0,
    totalOrders: orders.length,
    errors: 0,
    oilBreakdown: {}, // Разбивка по типам масла
  };

  // Инициализируем счетчики для каждого типа масла
  Object.keys(OIL_PRODUCTS).forEach((oilId) => {
    results.oilBreakdown[oilId] = {
      name: OIL_PRODUCTS[oilId].name,
      shortName: OIL_PRODUCTS[oilId].shortName,
      color: OIL_PRODUCTS[oilId].color,
      totalQuantity: 0,
      ordersCount: 0,
      orders: [],
    };
  });

  const batchSize = 5; // Уменьшаем размер пакета для снижения нагрузки на API
  const batches = [];

  // Разбиваем заказы на пакеты
  for (let i = 0; i < orders.length; i += batchSize) {
    batches.push(orders.slice(i, i + batchSize));
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    // Обрабатываем пакет заказов последовательно для снижения нагрузки
    for (const order of batch) {
      try {
        const items = await getOrderItems(order.id);
        let orderOilQuantity = 0;
        const orderOilItems = [];
        const orderOilsByType = {};

        // Инициализируем счетчики для этого заказа
        Object.keys(OIL_PRODUCTS).forEach((oilId) => {
          orderOilsByType[oilId] = 0;
        });

        for (const item of items) {
          if (item.entity && OIL_PRODUCTS[item.entity.id]) {
            const quantity = parseFloat(item.quantity) || 0;
            const oilId = item.entity.id.toString();

            orderOilQuantity += quantity;
            orderOilsByType[oilId] += quantity;

            orderOilItems.push({
              oilId: oilId,
              oilName: OIL_PRODUCTS[oilId].name,
              quantity,
              price: parseFloat(item.price) || 0,
              cost: parseFloat(item.cost) || 0,
            });
          }
        }

        if (orderOilQuantity > 0) {
          const orderData = {
            orderId: order.id,
            orderLabel: order.id_label,
            createdAt: order.created_at,
            totalQuantity: orderOilQuantity,
            status: order.status?.name || "Unknown",
            items: orderOilItems,
            oilsByType: orderOilsByType,
          };

          results.ordersWithOil.push(orderData);
          results.totalQuantity += orderOilQuantity;

          // Обновляем счетчики по типам масла
          Object.keys(orderOilsByType).forEach((oilId) => {
            if (orderOilsByType[oilId] > 0) {
              results.oilBreakdown[oilId].totalQuantity +=
                orderOilsByType[oilId];
              results.oilBreakdown[oilId].ordersCount++;
              results.oilBreakdown[oilId].orders.push(orderData);
            }
          });
        }
      } catch (error) {
        console.error(`Error processing order ${order.id}:`, error);
        results.errors++;
      }

      results.processedOrders++;

      // Небольшая задержка между заказами в пакете
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Отправляем прогресс через WebSocket
    if (socketId) {
      const progress = Math.round(
        (results.processedOrders / results.totalOrders) * 100,
      );
      io.to(socketId).emit("progress", {
        processed: results.processedOrders,
        total: results.totalOrders,
        percentage: progress,
        currentBatch: batchIndex + 1,
        totalBatches: batches.length,
        foundOrders: results.ordersWithOil.length,
        totalQuantity: results.totalQuantity.toFixed(2),
        errors: results.errors,
        oilBreakdown: Object.keys(results.oilBreakdown).map((oilId) => ({
          name: results.oilBreakdown[oilId].shortName,
          quantity: results.oilBreakdown[oilId].totalQuantity.toFixed(2),
          orders: results.oilBreakdown[oilId].ordersCount,
        })),
      });
    }

    // Увеличенная задержка между пакетами для избежания rate limiting
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return results;
}

// WebSocket подключение
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// Функция для получения списка заказов
async function getOrders(dateFilter, socketId = null) {
  try {
    let allOrders = [];
    let page = 1;
    let hasMorePages = true;
    let totalPages = 1;
    let totalCount = 0;

    console.log("🔍 Начинаем получение заказов с пагинацией...");

    while (hasMorePages) {
      // Строим URL вручную для корректной передачи параметров
      let url = `${API_BASE}/orders?branches=${BRANCH_ID}&page=${page}&page_size=100`;

      // Добавляем фильтр даты согласно документации API
      if (Array.isArray(dateFilter)) {
        dateFilter.forEach((date) => {
          url += `&created_at[]=${encodeURIComponent(date)}`;
        });
      } else {
        url += `&created_at[]=${encodeURIComponent(dateFilter)}`;
      }

      console.log(
        `📄 Запрашиваем страницу ${page}${totalPages > 1 ? ` из ${totalPages}` : ""}...`,
      );
      console.log(`📡 API URL: ${url}`);

      // Отправляем статус через WebSocket
      if (socketId) {
        const progressPercent =
          totalPages > 1 ? Math.round((page / totalPages) * 100) : 0;
        io.to(socketId).emit("status", {
          message: `Загружаем заказы... Страница ${page}${totalPages > 1 ? ` из ${totalPages}` : ""}`,
          stage: "fetching_orders",
          progress: progressPercent,
          details: {
            currentPage: page,
            totalPages: totalPages,
            loadedOrders: allOrders.length,
            totalOrders: totalCount,
          },
        });
      }

      const response = await fetch(url, {
        method: "GET",
        headers: getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      // Обновляем информацию о пагинации после первого запроса
      if (page === 1) {
        totalPages = data.total_pages;
        totalCount = data.count;
        console.log(
          `📊 Найдено ${totalCount} заказов на ${totalPages} страницах (по ${data.page_size} на страницу)`,
        );
      }

      // Добавляем заказы с текущей страницы к общему списку
      allOrders = allOrders.concat(data.data || []);

      console.log(
        `✅ Страница ${page}: получено ${data.data ? data.data.length : 0} заказов (всего: ${allOrders.length})`,
      );

      // Проверяем, есть ли еще страницы
      hasMorePages = page < data.total_pages;
      page++;

      // Задержка между запросами для избежания rate limiting
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    console.log(
      `🎯 Завершено! Получено ${allOrders.length} заказов со всех ${page - 1} страниц`,
    );
    return allOrders;
  } catch (error) {
    console.error("Error fetching orders:", error);
    throw error;
  }
}

// API маршрут для получения данных об использовании масла
app.get("/api/oil-usage", async (req, res) => {
  try {
    const { year, month } = req.query;

    console.log("🔍 DEBUG - Received params:", {
      year,
      month,
      yearType: typeof year,
    });
    const socketId = req.headers["socket-id"];

    // Проверяем параметры
    if (!year) {
      return res.status(400).json({
        success: false,
        error: "Не указан год",
      });
    }

    let dateFilter;
    let periodLabel;

    if (year === "all") {
      // Весь период - от 2020 года до сегодня
      const startDate = "2020-01-01T00:00:00Z";
      const currentDate = new Date();
      const endDate = currentDate.toISOString();

      dateFilter = [startDate, endDate];
      periodLabel = "Весь период";

      console.log(
        `Fetching orders for ${periodLabel}: ${startDate} - ${endDate}`,
      );
    } else if (month) {
      // Конкретный месяц - устанавливаем диапазон от начала до конца месяца
      const monthNum = parseInt(month);
      const startDate = `${year}-${monthNum.toString().padStart(2, "0")}-01T00:00:00Z`;

      // Вычисляем последний день месяца
      const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
      const nextYear = monthNum === 12 ? parseInt(year) + 1 : parseInt(year);
      const endDate = `${nextYear}-${nextMonth.toString().padStart(2, "0")}-01T00:00:00Z`;

      dateFilter = [startDate, endDate];

      const monthNames = [
        "Январь",
        "Февраль",
        "Март",
        "Апрель",
        "Май",
        "Июнь",
        "Июль",
        "Август",
        "Сентябрь",
        "Октябрь",
        "Ноябрь",
        "Декабрь",
      ];
      periodLabel = `${monthNames[monthNum - 1]} ${year}`;

      console.log(
        `Fetching orders for ${periodLabel}: ${startDate} - ${endDate}`,
      );
    } else {
      // Весь год - от начала года до конца года
      const startDate = `${year}-01-01T00:00:00Z`;
      const endDate = `${parseInt(year) + 1}-01-01T00:00:00Z`;

      dateFilter = [startDate, endDate];
      periodLabel = `${year} год`;

      console.log(
        `Fetching orders for ${periodLabel}: ${startDate} - ${endDate}`,
      );
    }

    // Отправляем начальный статус
    if (socketId) {
      io.to(socketId).emit("status", {
        message: `Получение заказов за ${periodLabel}...`,
        stage: "fetching_orders",
      });
    }

    const orders = await getOrders(dateFilter, socketId);
    console.log(
      `✅ Получено ${orders.length} заказов для периода: ${periodLabel}`,
    );

    // Отправляем статус начала анализа
    if (socketId) {
      io.to(socketId).emit("status", {
        message: `Найдено ${orders.length} заказов за ${periodLabel}. Начинаем анализ...`,
        stage: "analyzing_orders",
      });
    }

    const results = await analyzeOilUsage(orders, socketId);

    res.json({
      success: true,
      period: periodLabel,
      dateRange: Array.isArray(dateFilter)
        ? {
            start: dateFilter[0],
            end: dateFilter[1],
          }
        : { start: dateFilter },
      ...results,
    });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Служить статические файлы и главную страницу
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Fallback для любых других маршрутов (кроме API)
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔗 API Base: ${API_BASE}`);
  console.log(`🏢 Branch ID: ${BRANCH_ID}`);
  console.log(
    `🛢️ Tracking oils:`,
    Object.keys(OIL_PRODUCTS).map((id) => `${OIL_PRODUCTS[id].name} (${id})`),
  );

  if (process.env.NODE_ENV === "production") {
    console.log("🌐 Production mode: Ready for external connections");
  } else {
    console.log("🏠 Local development: http://localhost:" + PORT);
  }
});
