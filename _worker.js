function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function errorJson(error, context, status = 500) {
  const message = error?.message || "Error interno de Cloudflare.";
  console.error(`[copiloto] ${context}`, {
    message,
    stack: error?.stack || "",
    cause: error?.cause || ""
  });
  return json({ error: message, context }, status);
}

function requireDb(env) {
  if (!env.DB) {
    throw new Error("Falta el binding D1 DB. Configura el binding DB en Cloudflare Pages.");
  }
  return env.DB;
}

function requireR2(env) {
  const bucket = env.BUCKET || env.ASSETS_R2 || env.R2 || (env.ASSETS && typeof env.ASSETS.put === "function" ? env.ASSETS : null);
  if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function" || typeof bucket.delete !== "function") {
    throw new Error("Falta el binding R2 BUCKET. En Cloudflare Pages agrega R2 Bucket con variable BUCKET y bucket copiloto. No uses ASSETS para R2 cuando existe _worker.js.");
  }
  return bucket;
}

async function ensureSchema(db) {
  const schemaStatements = [
    `CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phrase TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      official_link TEXT NOT NULL DEFAULT '',
      youtube_url TEXT NOT NULL DEFAULT '',
      thumbnail_url TEXT NOT NULL DEFAULT '',
      showroom_title TEXT NOT NULL DEFAULT '',
      showroom_text TEXT NOT NULL DEFAULT '',
      showroom_style TEXT NOT NULL DEFAULT 'clean',
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS model_advantages (
      model_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (model_id, position)
    )`,
    `CREATE TABLE IF NOT EXISTS model_versions (
      model_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (model_id, position)
    )`,
    `CREATE TABLE IF NOT EXISTS model_features (
      model_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (model_id, position)
    )`,
    `CREATE TABLE IF NOT EXISTS model_gallery_images (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      image_url TEXT NOT NULL,
      image_key TEXT NOT NULL DEFAULT '',
      alt_text TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS assets (
      key TEXT PRIMARY KEY,
      public_url TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS prospects (
      id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      model_id TEXT NOT NULL DEFAULT '',
      model_label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Nuevo',
      next_action TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      follow_up_at TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS agenda_items (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'Hoy',
      data_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_models_brand ON models (brand_id, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_gallery_model ON model_gallery_images (model_id, position)`,
    `CREATE INDEX IF NOT EXISTS idx_assets_model ON assets (model_id, role)`,
    `CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects (status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agenda_state ON agenda_items (state, sort_order)`
  ];

  for (const statement of schemaStatements) {
    await db.prepare(statement).run();
  }
}

function cleanText(value, fallback = "") {
  const text = String(value ?? fallback).trim();
  return text || String(fallback ?? "").trim();
}

function cleanList(value) {
  return Array.isArray(value)
    ? value.map(item => cleanText(item)).filter(Boolean)
    : String(value || "").split(/\r?\n|,/).map(item => item.trim()).filter(Boolean);
}

function slugify(value, fallback = "item") {
  return cleanText(value, fallback)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function normalizeBrand(value, fallback = "JETOUR") {
  return cleanText(value, fallback).toUpperCase();
}

function normalizeBrandRecord(input, index = 0) {
  const name = normalizeBrand(input?.name || input?.id || input, index === 1 ? "MAXUS" : "JETOUR");
  return {
    id: normalizeBrand(input?.id || name, name),
    name,
    sortOrder: Number.isFinite(input?.sortOrder) ? input.sortOrder : index
  };
}

function assetKeyFromUrl(value) {
  try {
    const url = new URL(value, "https://copiloto.local");
    if (url.pathname !== "/api/assets") return "";
    return url.searchParams.get("key") || "";
  } catch {
    return "";
  }
}

function normalizeModel(input, index = 0) {
  const brand = normalizeBrand(input?.brand || input?.brandId, "JETOUR");
  const name = cleanText(input?.model || input?.name, "Nuevo modelo");
  const id = cleanText(input?.id, `${slugify(brand)}-${slugify(name)}`);
  return {
    id,
    brand,
    model: name,
    phrase: cleanText(input?.phrase, "Completa la frase comercial antes de presentar este modelo."),
    summary: cleanText(input?.summary, "Completa el resumen comercial desde Administración."),
    advantages: cleanList(input?.advantages),
    versions: cleanList(input?.versions),
    features: cleanList(input?.features),
    link: cleanText(input?.link || input?.officialLink, "https://www.difor.cl/"),
    video: cleanText(input?.video || input?.youtubeUrl),
    thumbnail: cleanText(input?.thumbnail || input?.thumbnailUrl),
    gallery: cleanList(input?.gallery),
    showroomTitle: cleanText(input?.showroomTitle, name),
    showroomText: cleanText(input?.showroomText, input?.summary || ""),
    showroomStyle: ["clean", "soft", "contrast"].includes(input?.showroomStyle) ? input.showroomStyle : "clean",
    sortOrder: Number.isFinite(input?.sortOrder) ? input.sortOrder : index
  };
}

function normalizeProspect(input, index = 0) {
  const models = cleanList(input?.models || input?.model || input?.modelLabel);
  const versions = cleanList(input?.versions || input?.version);
  return {
    id: cleanText(input?.id, `prospect-${Date.now()}-${index}`),
    client: cleanText(input?.client || input?.clientName, "Cliente sin nombre"),
    phone: cleanText(input?.phone),
    email: cleanText(input?.email),
    models,
    versions,
    modelId: cleanText(input?.modelId),
    model: models.join(" · ") || cleanText(input?.model || input?.modelLabel),
    status: cleanText(input?.status, "Nuevo"),
    next: cleanText(input?.next || input?.nextAction),
    note: cleanText(input?.note, "Sin observacion registrada."),
    source: cleanText(input?.source, "No informado"),
    advisor: cleanText(input?.advisor, "Ejecutivo Comercial"),
    date: cleanText(input?.date || input?.followUpAt)
  };
}

function normalizeAgendaItem(input, index = 0) {
  return {
    id: cleanText(input?.id, `agenda-${Date.now()}-${index}`),
    time: cleanText(input?.time),
    title: cleanText(input?.title, "Actividad comercial"),
    type: cleanText(input?.type, "Seguimiento"),
    state: cleanText(input?.state, "Hoy"),
    sortOrder: Number.isFinite(input?.sortOrder) ? input.sortOrder : index
  };
}

const DEFAULT_MODELS = [
  {
    id: "jetour-t2",
    brand: "JETOUR",
    model: "T2",
    phrase: "SUV 4x4 para clientes que buscan presencia, seguridad y aventura.",
    summary: "Jetour T2 es una propuesta visualmente potente para familias activas y clientes que quieren diferenciarse sin perder confort.",
    advantages: ["Diseno robusto", "Traccion 4x4", "Interior tecnologico"],
    versions: ["T2 4x4"],
    features: ["Pantalla panoramica", "Asistencias de conduccion", "Modos de manejo"],
    link: "https://www.difor.cl/",
    video: "https://www.youtube.com/embed/UPsVfGKPl_Y",
    thumbnail: "",
    gallery: [],
    showroomTitle: "Jetour T2",
    showroomText: "Una pieza de alto impacto para abrir conversaciones comerciales.",
    showroomStyle: "contrast"
  },
  {
    id: "jetour-x70-plus",
    brand: "JETOUR",
    model: "X70 Plus",
    phrase: "SUV familiar amplio para viajes, comodidad y venta consultiva.",
    summary: "X70 Plus permite presentar espacio, equipamiento y valor percibido en una conversacion clara.",
    advantages: ["Tres filas", "Confort familiar", "Valor competitivo"],
    versions: ["X70 Plus"],
    features: ["Cabina amplia", "Conectividad", "Seguridad activa"],
    link: "https://www.difor.cl/",
    video: "",
    thumbnail: "",
    gallery: [],
    showroomTitle: "Jetour X70 Plus",
    showroomText: "Enfocado en familias que necesitan espacio sin perder estilo.",
    showroomStyle: "clean"
  },
  {
    id: "maxus-t90",
    brand: "MAXUS",
    model: "T90",
    phrase: "Pick-up para trabajo, flotas y clientes que exigen capacidad.",
    summary: "Maxus T90 ayuda a vender una solucion productiva para empresas, faenas y uso mixto.",
    advantages: ["Capacidad de carga", "Motor eficiente", "Uso mixto"],
    versions: ["T90"],
    features: ["Chasis robusto", "Cabina doble", "Asistencia al conductor"],
    link: "https://www.difor.cl/",
    video: "",
    thumbnail: "",
    gallery: [],
    showroomTitle: "Maxus T90",
    showroomText: "Una alternativa directa para necesidades comerciales y familiares.",
    showroomStyle: "soft"
  },
  {
    id: "karry-q22",
    brand: "KARRY",
    model: "Q22",
    phrase: "Vehiculo comercial compacto para reparto y carga liviana.",
    summary: "Karry Q22 permite presentar una solucion practica para pequenos negocios y operacion urbana.",
    advantages: ["Formato compacto", "Uso comercial diario", "Costo operativo claro"],
    versions: ["Cargo", "Full"],
    features: ["Zona de carga practica", "Cabina funcional", "Maniobrabilidad urbana"],
    link: "https://www.difor.cl/",
    video: "",
    thumbnail: "",
    gallery: [],
    showroomTitle: "Karry Q22",
    showroomText: "Un apoyo directo para clientes que buscan una herramienta de trabajo.",
    showroomStyle: "clean"
  }
];

const DEFAULT_PROSPECTS = [
  { id: "prospect-demo-1", client: "Maria Cardenas", phone: "+56 9 1111 2222", models: ["Jetour T2", "Karry Q22"], versions: ["T2 4x4", "Cargo"], source: "Showroom", advisor: "Axel Rojas", status: "Cotizando", next: "Enviar alternativas revisadas", note: "Busca entrega antes de vacaciones.", date: "Hoy 16:30" },
  { id: "prospect-demo-2", client: "Constructora Austral", phone: "+56 9 3333 4444", models: ["Maxus T90"], versions: ["T90"], source: "Referido", advisor: "Axel Rojas", status: "Evaluacion", next: "Coordinar prueba de manejo", note: "Comparan pick-up para supervisores.", date: "Manana 10:00" }
];

const DEFAULT_AGENDA = [
  { id: "agenda-demo-1", time: "09:15", title: "Llamar a Maria Cardenas", type: "Seguimiento", state: "Hoy" },
  { id: "agenda-demo-2", time: "11:30", title: "Visita showroom: Jetour T2", type: "Visita", state: "Hoy" },
  { id: "agenda-demo-3", time: "15:00", title: "Entrega documentos T90", type: "Entrega", state: "Pendientes" }
];

const DEFAULT_CONFIG = {
  app: {
    productName: "DIFOR Chiloe - Copiloto Comercial",
    persistence: "cloudflare-d1-r2",
    updatedFrom: "seed"
  }
};

async function tableCount(db, table) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
  return Number(row?.count || 0);
}

async function listByModel(db, table, column = "value") {
  const result = await db.prepare(`SELECT model_id, ${column} AS value FROM ${table} ORDER BY model_id, position`).all();
  return (result.results || []).reduce((acc, row) => {
    if (!acc[row.model_id]) acc[row.model_id] = [];
    acc[row.model_id].push(row.value);
    return acc;
  }, {});
}

async function listBrands(db) {
  const result = await db.prepare("SELECT id, name, sort_order FROM brands ORDER BY sort_order, name").all();
  return (result.results || []).map(row => ({
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order
  }));
}

async function replaceModels(db, inputModels, inputBrands = []) {
  await ensureSchema(db);
  const now = new Date().toISOString();
  const models = (Array.isArray(inputModels) ? inputModels : []).map(normalizeModel).filter(model => model.id && model.model);
  if (!models.length) throw new Error("Debe existir al menos un modelo.");

  const brandMap = new Map();
  (Array.isArray(inputBrands) ? inputBrands : []).map(normalizeBrandRecord).forEach(brand => brandMap.set(brand.id, brand));
  models.forEach((model, index) => {
    if (!brandMap.has(model.brand)) brandMap.set(model.brand, { id: model.brand, name: model.brand, sortOrder: index });
  });
  const brands = Array.from(brandMap.values());

  const statements = [
    db.prepare("DELETE FROM model_gallery_images"),
    db.prepare("DELETE FROM model_features"),
    db.prepare("DELETE FROM model_versions"),
    db.prepare("DELETE FROM model_advantages"),
    db.prepare("DELETE FROM models"),
    db.prepare("DELETE FROM brands")
  ];

  brands.forEach((brand, index) => {
    statements.push(db.prepare("INSERT INTO brands (id, name, sort_order, updated_at) VALUES (?, ?, ?, ?)").bind(
      brand.id,
      brand.name,
      Number.isFinite(brand.sortOrder) ? brand.sortOrder : index,
      now
    ));
  });

  models.forEach((model, index) => {
    statements.push(db.prepare(
      `INSERT INTO models
        (id, brand_id, name, phrase, summary, official_link, youtube_url, thumbnail_url, showroom_title, showroom_text, showroom_style, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      model.id,
      model.brand,
      model.model,
      model.phrase,
      model.summary,
      model.link,
      model.video,
      model.thumbnail,
      model.showroomTitle,
      model.showroomText,
      model.showroomStyle,
      index,
      now
    ));

    model.advantages.forEach((value, position) => {
      statements.push(db.prepare("INSERT INTO model_advantages (model_id, position, value) VALUES (?, ?, ?)").bind(model.id, position, value));
    });
    model.versions.forEach((value, position) => {
      statements.push(db.prepare("INSERT INTO model_versions (model_id, position, value) VALUES (?, ?, ?)").bind(model.id, position, value));
    });
    model.features.forEach((value, position) => {
      statements.push(db.prepare("INSERT INTO model_features (model_id, position, value) VALUES (?, ?, ?)").bind(model.id, position, value));
    });
    model.gallery.forEach((imageUrl, position) => {
      statements.push(db.prepare(
        "INSERT INTO model_gallery_images (id, model_id, image_url, image_key, alt_text, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        `${model.id}-${position}`,
        model.id,
        imageUrl,
        assetKeyFromUrl(imageUrl),
        `${model.brand} ${model.model} foto ${position + 1}`,
        position,
        now
      ));
    });
  });

  await db.batch(statements);
  return { brands, models, updatedAt: now };
}

async function listModels(db) {
  await ensureSchema(db);
  const [brands, modelsResult, advantages, versions, features, gallery] = await Promise.all([
    listBrands(db),
    db.prepare("SELECT * FROM models ORDER BY sort_order, name").all(),
    listByModel(db, "model_advantages"),
    listByModel(db, "model_versions"),
    listByModel(db, "model_features"),
    db.prepare("SELECT model_id, image_url FROM model_gallery_images ORDER BY model_id, position").all()
  ]);

  const galleryByModel = (gallery.results || []).reduce((acc, row) => {
    if (!acc[row.model_id]) acc[row.model_id] = [];
    acc[row.model_id].push(row.image_url);
    return acc;
  }, {});

  const models = (modelsResult.results || []).map(row => ({
    id: row.id,
    brand: row.brand_id,
    model: row.name,
    phrase: row.phrase,
    summary: row.summary,
    advantages: advantages[row.id] || [],
    versions: versions[row.id] || [],
    features: features[row.id] || [],
    link: row.official_link,
    video: row.youtube_url,
    thumbnail: row.thumbnail_url,
    gallery: galleryByModel[row.id] || [],
    showroomTitle: row.showroom_title || row.name,
    showroomText: row.showroom_text || row.summary,
    showroomStyle: row.showroom_style || "clean",
    sortOrder: row.sort_order
  }));

  return { brands, models };
}

async function replaceProspects(db, inputProspects) {
  await ensureSchema(db);
  const prospects = (Array.isArray(inputProspects) ? inputProspects : []).map(normalizeProspect);
  const now = new Date().toISOString();
  const statements = [db.prepare("DELETE FROM prospects")];
  prospects.forEach((prospect) => {
    statements.push(db.prepare(
      `INSERT INTO prospects
        (id, client_name, model_id, model_label, status, next_action, note, follow_up_at, data_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      prospect.id,
      prospect.client,
      prospect.modelId,
      prospect.model,
      prospect.status,
      prospect.next,
      prospect.note,
      prospect.date,
      JSON.stringify(prospect),
      now
    ));
  });
  await db.batch(statements);
  return { prospects, updatedAt: now };
}

async function listProspects(db) {
  await ensureSchema(db);
  const result = await db.prepare("SELECT * FROM prospects ORDER BY updated_at DESC").all();
  return (result.results || []).map((row, index) => {
    let extra = {};
    try {
      extra = JSON.parse(row.data_json || "{}");
    } catch {
      extra = {};
    }
    return normalizeProspect({
      ...extra,
      id: row.id,
      client: row.client_name,
      modelId: row.model_id,
      model: row.model_label,
      status: row.status,
      next: row.next_action,
      note: row.note,
      date: row.follow_up_at
    }, index);
  });
}

async function replaceAgenda(db, inputAgenda) {
  await ensureSchema(db);
  const agenda = (Array.isArray(inputAgenda) ? inputAgenda : []).map(normalizeAgendaItem);
  const now = new Date().toISOString();
  const statements = [db.prepare("DELETE FROM agenda_items")];
  agenda.forEach((item, index) => {
    statements.push(db.prepare(
      `INSERT INTO agenda_items
        (id, time, title, type, state, data_json, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      item.id,
      item.time,
      item.title,
      item.type,
      item.state,
      JSON.stringify(item),
      index,
      now
    ));
  });
  await db.batch(statements);
  return { agenda, updatedAt: now };
}

async function listAgenda(db) {
  await ensureSchema(db);
  const result = await db.prepare("SELECT * FROM agenda_items ORDER BY sort_order, updated_at DESC").all();
  return (result.results || []).map(row => ({
    id: row.id,
    time: row.time,
    title: row.title,
    type: row.type,
    state: row.state,
    sortOrder: row.sort_order
  }));
}

async function replaceConfig(db, inputConfig) {
  await ensureSchema(db);
  const config = inputConfig && typeof inputConfig === "object" && !Array.isArray(inputConfig) ? inputConfig : {};
  const now = new Date().toISOString();
  const statements = [db.prepare("DELETE FROM app_config")];
  Object.entries(config).forEach(([key, value]) => {
    statements.push(db.prepare("INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)").bind(
      key,
      JSON.stringify(value),
      now
    ));
  });
  await db.batch(statements);
  return { config, updatedAt: now };
}

async function listConfig(db) {
  await ensureSchema(db);
  const result = await db.prepare("SELECT key, value_json FROM app_config ORDER BY key").all();
  const config = {};
  for (const row of result.results || []) {
    try {
      config[row.key] = JSON.parse(row.value_json);
    } catch {
      config[row.key] = row.value_json;
    }
  }
  return config;
}

async function seedIfEmpty(db) {
  await ensureSchema(db);
  const [modelCount, prospectCount, agendaCount, configCount] = await Promise.all([
    tableCount(db, "models"),
    tableCount(db, "prospects"),
    tableCount(db, "agenda_items"),
    tableCount(db, "app_config")
  ]);

  if (!modelCount) {
    await replaceModels(db, DEFAULT_MODELS, [{ id: "JETOUR", name: "JETOUR" }, { id: "MAXUS", name: "MAXUS" }, { id: "KARRY", name: "KARRY" }]);
  }
  if (!prospectCount) {
    await replaceProspects(db, DEFAULT_PROSPECTS);
  }
  if (!agendaCount) {
    await replaceAgenda(db, DEFAULT_AGENDA);
  }
  if (!configCount) {
    await replaceConfig(db, DEFAULT_CONFIG);
  }
}

async function countAll(db) {
  await ensureSchema(db);
  const [brands, models, prospects, agenda, assets, config] = await Promise.all([
    tableCount(db, "brands"),
    tableCount(db, "models"),
    tableCount(db, "prospects"),
    tableCount(db, "agenda_items"),
    tableCount(db, "assets"),
    tableCount(db, "app_config")
  ]);
  return { brands, models, prospects, agenda, assets, config };
}


const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    "access-control-max-age": "86400"
  };
}

function jsonWithCors(data, status = 200) {
  const response = json(data, status);
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { status: response.status, headers });
}

function errorJsonWithCors(error, context, status = 500) {
  const message = error?.message || "Error interno de Cloudflare.";
  console.error(`[copiloto] ${context}`, { message, stack: error?.stack || "" });
  return jsonWithCors({ error: message, context }, status);
}

function safeSegment(value, fallback = "asset") {
  return String(value || fallback)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function assetUrl(key) {
  return `/api/assets?key=${encodeURIComponent(key)}`;
}

async function recordAsset(env, asset) {
  if (!env.DB) return;
  const db = requireDb(env);
  await ensureSchema(db);
  await db.prepare(
    `INSERT OR REPLACE INTO assets
      (key, public_url, content_type, size, role, model_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    asset.key,
    asset.url,
    asset.contentType,
    asset.size,
    asset.role,
    asset.modelId,
    new Date().toISOString()
  ).run();
}

async function handleHealth(env) {
  const db = requireDb(env);
  const bucket = requireR2(env);
  await seedIfEmpty(db);
  const counts = await countAll(db);
  return jsonWithCors({
    ok: true,
    d1: true,
    r2: true,
    r2Binding: bucket === env.BUCKET ? "BUCKET" : bucket === env.ASSETS_R2 ? "ASSETS_R2" : bucket === env.R2 ? "R2" : "ASSETS",
    counts,
    source: "cloudflare-pages-worker-direct-upload",
    updatedAt: new Date().toISOString()
  });
}

async function handleAssets(request, env) {
  const bucket = requireR2(env);
  const url = new URL(request.url);
  if (request.method === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return jsonWithCors({ ok: false, error: "Falta key.", route: "/api/assets" }, 400);
    const object = await bucket.get(key);
    if (!object) return jsonWithCors({ error: "Archivo no encontrado en R2." }, 404);
    const headers = new Headers(corsHeaders());
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    return new Response(object.body, { headers });
  }
  if (request.method === "POST") {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonWithCors({ error: "Adjunta un archivo en el campo file." }, 400);
    if (!file.type.startsWith("image/") && file.type !== "application/pdf") return jsonWithCors({ error: "Solo se aceptan imágenes o PDF." }, 415);
    if (file.size > MAX_UPLOAD_BYTES) return jsonWithCors({ error: "El archivo supera 12 MB." }, 413);
    const folder = safeSegment(form.get("folder"), "uploads");
    const modelId = safeSegment(form.get("modelId"), "modelo");
    const role = safeSegment(form.get("role"), "asset");
    const filename = safeSegment(file.name, "archivo");
    const key = `${folder}/${modelId}/${role}/${Date.now()}-${crypto.randomUUID()}-${filename}`;
    const urlOut = assetUrl(key);
    await bucket.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { originalName: file.name || "", modelId, role }
    });
    await recordAsset(env, { key, url: urlOut, contentType: file.type || "application/octet-stream", size: file.size || 0, role, modelId });
    return jsonWithCors({ key, url: urlOut, contentType: file.type, size: file.size, source: "cloudflare-r2" });
  }
  if (request.method === "DELETE") {
    const key = url.searchParams.get("key") || assetKeyFromUrl(url.searchParams.get("url") || "");
    if (!key) return jsonWithCors({ error: "Falta key." }, 400);
    await bucket.delete(key);
    if (env.DB) {
      const db = requireDb(env);
      await ensureSchema(db);
      await db.prepare("DELETE FROM assets WHERE key = ?").bind(key).run();
    }
    return jsonWithCors({ ok: true, source: "cloudflare-r2" });
  }
  return jsonWithCors({ error: "Metodo no permitido." }, 405);
}

async function handleModels(request, env) {
  const db = requireDb(env);
  await seedIfEmpty(db);
  if (request.method === "GET") {
    const data = await listModels(db);
    return jsonWithCors({ ...data, source: "cloudflare-d1", updatedAt: new Date().toISOString() });
  }
  if (request.method === "POST" || request.method === "PUT") {
    const body = await request.json();
    const result = await replaceModels(db, body.models, body.brands);
    return jsonWithCors({ ok: true, ...result, source: "cloudflare-d1" });
  }
  return jsonWithCors({ error: "Metodo no permitido." }, 405);
}

async function handleProspects(request, env) {
  const db = requireDb(env);
  await seedIfEmpty(db);
  if (request.method === "GET") {
    const prospects = await listProspects(db);
    return jsonWithCors({ prospects, source: "cloudflare-d1", updatedAt: new Date().toISOString() });
  }
  if (request.method === "POST" || request.method === "PUT") {
    const body = await request.json();
    const result = await replaceProspects(db, body.prospects);
    return jsonWithCors({ ok: true, ...result, source: "cloudflare-d1" });
  }
  return jsonWithCors({ error: "Metodo no permitido." }, 405);
}

async function handleAgenda(request, env) {
  const db = requireDb(env);
  await seedIfEmpty(db);
  if (request.method === "GET") {
    const agenda = await listAgenda(db);
    return jsonWithCors({ agenda, source: "cloudflare-d1", updatedAt: new Date().toISOString() });
  }
  if (request.method === "POST" || request.method === "PUT") {
    const body = await request.json();
    const result = await replaceAgenda(db, body.agenda);
    return jsonWithCors({ ok: true, ...result, source: "cloudflare-d1" });
  }
  return jsonWithCors({ error: "Metodo no permitido." }, 405);
}

async function handleConfig(request, env) {
  const db = requireDb(env);
  await seedIfEmpty(db);
  if (request.method === "GET") {
    const config = await listConfig(db);
    return jsonWithCors({ config, source: "cloudflare-d1", updatedAt: new Date().toISOString() });
  }
  if (request.method === "POST" || request.method === "PUT") {
    const body = await request.json();
    const result = await replaceConfig(db, body.config);
    return jsonWithCors({ ok: true, ...result, source: "cloudflare-d1" });
  }
  return jsonWithCors({ error: "Metodo no permitido." }, 405);
}

async function handleAssistant(request, env) {
  if (request.method !== "POST") return jsonWithCors({ error: "Metodo no permitido." }, 405);
  const hasKey = Boolean(env.OPENAI_API_KEY);
  return jsonWithCors({
    ok: false,
    readyForSecureBackend: true,
    providerConfigured: hasKey,
    message: hasKey
      ? "Ruta preparada. Conecta aqui la llamada server-side al proveedor usando OPENAI_API_KEY."
      : "Configura OPENAI_API_KEY como variable de entorno de Cloudflare antes de activar respuestas IA reales.",
    guardrails: [
      "No exponer API keys en frontend.",
      "Responder solo con información cargada en Administración.",
      "No inventar marcas, modelos, versiones ni datos comerciales."
    ]
  }, 501);
}

async function routeApi(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/health") return await handleHealth(env);
    if (url.pathname === "/api/assets") return await handleAssets(request, env);
    if (url.pathname === "/api/models") return await handleModels(request, env);
    if (url.pathname === "/api/prospects") return await handleProspects(request, env);
    if (url.pathname === "/api/agenda") return await handleAgenda(request, env);
    if (url.pathname === "/api/config") return await handleConfig(request, env);
    if (url.pathname === "/api/assistant") return await handleAssistant(request, env);
    return jsonWithCors({ error: "Ruta API no encontrada." }, 404);
  } catch (error) {
    return errorJsonWithCors(error, `${request.method} ${url.pathname}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return routeApi(request, env);
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  }
};
