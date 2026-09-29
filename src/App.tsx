import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { startAutomaticBackups } from "./backup/automaticBackup";
import { backupReminderWeekdays, checkBackupReminder, DEFAULT_BACKUP_REMINDER_SETTINGS, loadBackupReminderSettings, recordBackupExport, saveBackupReminderSettings, type BackupReminderDue, type BackupReminderSettings } from "./backup/backupReminder";
import { repository } from "./db/repository";
import { SyncService, clearPairingSecretFromLocation, createInviteUrl, pairingSecretFromLocation, type SyncViewState } from "./sync/syncService";
import type { AppSnapshot, BackupDocument, CartItem, DailyTurnover, InventoryMovement, LocalBackupRecord, Product, Sale, SaleItem, UnitType } from "./types";
import { activeSales, categoryName, formatDateHeading, formatMoney, formatProductStock, formatTime, localDateKey, productBaseUnitLabel, productBundleUnitLabel, productHasBundle, productUnitLabel, saleSummary, stockMap, thresholdCartons } from "./utils/format";
import { displayCostCentsAtAverage, inventoryCostStates, inventoryValueCentsAtAverage } from "./utils/cost";

type Tab = "today" | "history" | "inventory" | "products" | "turnover";
type TurnoverField = "cash" | "pos" | "lotteryPayout";
type Notice = { kind: "success" | "error"; message: string };
type AnalysisPeriod = "today" | "7d" | "30d" | "month" | "custom";
const isBusinessOpen = (date: Date) => {
  const current = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return current >= "06:00" && current < "19:00";
};
const formatTobaccoSpec = (grams?: number) => grams && grams >= 1000 && grams % 1000 === 0 ? `${grams / 1000}公斤/件` : `${grams ?? 0}克/件`;

const syncService = new SyncService(repository);
const EMPTY_SYNC: SyncViewState = { status: navigator.onLine ? "local" : "offline", peerCount: 0 };

const centsFromInput = (value: FormDataEntryValue | string | null) => Math.max(0, Math.round(Number(value || 0) * 100));
const optionalCentsFromInput = (value: FormDataEntryValue | string | null) => {
  const text = String(value ?? "").trim();
  if (text === "") return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? Math.max(0, Math.round(number * 100)) : undefined;
};
const numberFromInput = (value: FormDataEntryValue | null) => Math.max(0, Math.round(Number(value || 0)));
const optionalNumberFromInput = (value: FormDataEntryValue | null) => {
  const text = String(value ?? "").trim();
  return text === "" ? undefined : Math.max(0, Math.round(Number(text)));
};
const optionalDecimalFromInput = (value: FormDataEntryValue | null) => {
  const text = String(value ?? "").trim();
  if (text === "") return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? Math.max(0, number) : undefined;
};
const weightFromNameInput = (value: string) => {
  const match = value.match(/(\d+(?:\.\d+)?)\s*(kg|公斤|g|克)/i);
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isFinite(number) ? Math.max(1, Math.round(number * (/kg|公斤/i.test(match[2]) ? 1000 : 1))) : undefined;
};
const triggerTapHaptic = () => undefined;

const downloadBackupFile = async (prefix = "project-one-backup") => {
  const backup = await repository.exportBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${prefix}-${localDateKey(new Date())}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  await recordBackupExport();
};

type DailySummary = {
  revenue: number;
  profit: number;
  customers: number;
  packs: number;
  cartons: number;
  quantity: number;
  unitTotals: Record<string, number>;
};

type BreakdownMetric = "quantity" | "revenue" | "profit";
type BreakdownRequest = { metric: BreakdownMetric; unitLabel?: string };
type BreakdownRow = { name: string; value: number; unitLabel?: string };

const summarizeSales = (sales: Sale[], saleItems: SaleItem[], products: Product[] = []): DailySummary => {
  const saleIds = new Set(sales.map((sale) => sale.id));
  return saleItems.reduce<DailySummary>(
    (result, item) => {
      if (!saleIds.has(item.saleId)) return result;
      if (item.unitType === "carton") result.cartons += item.quantity;
      else result.packs += item.quantity;
      const product = products.find((entry) => entry.id === item.productId);
      const isTobacco = product?.categoryKind === "tobacco";
      const displayQuantity = isTobacco ? item.unitsInPacks * item.quantity : item.quantity;
      const unitLabel = isTobacco ? "克" : item.unitLabelSnapshot ?? (item.unitType === "carton" ? "条" : "包");
      result.quantity += displayQuantity;
      result.unitTotals[unitLabel] = (result.unitTotals[unitLabel] ?? 0) + displayQuantity;
      return result;
    },
    {
      revenue: sales.reduce((sum, sale) => sum + sale.revenueCents, 0),
      profit: sales.reduce((sum, sale) => sum + sale.profitCents, 0),
      customers: sales.length,
      packs: 0,
      cartons: 0,
      quantity: 0,
      unitTotals: {},
    },
  );
};

const buildBreakdownRows = (items: SaleItem[], products: Product[], request: BreakdownRequest) => {
  const rows = new Map<string, BreakdownRow>();
  items.forEach((item) => {
    const product = products.find((entry) => entry.id === item.productId);
    const isTobacco = product?.categoryKind === "tobacco";
    if (request.metric === "quantity") {
      const unitLabel = isTobacco ? "克" : item.unitLabelSnapshot ?? (item.unitType === "carton" ? "条" : "包");
      if (unitLabel !== request.unitLabel) return;
      const value = isTobacco ? item.unitsInPacks * item.quantity : item.quantity;
      const current = rows.get(item.productId) ?? { name: item.productNameSnapshot, value: 0, unitLabel };
      current.value += value;
      rows.set(item.productId, current);
      return;
    }
    const value = request.metric === "revenue" ? item.lineRevenueCents : item.lineProfitCents;
    const current = rows.get(item.productId) ?? { name: item.productNameSnapshot, value: 0 };
    current.value += value;
    rows.set(item.productId, current);
  });
  return Array.from(rows.values()).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
};

type DailySalesHistoryRow = { date: string; totals: Record<string, number> };

const buildDailySalesHistory = (sales: Sale[], saleItems: SaleItem[], products: Product[]) => {
  const active = activeSales(sales);
  const activeSalesById = new Map(active.map((sale) => [sale.id, sale]));
  const productsById = new Map(products.map((product) => [product.id, product]));
  const rows = new Map<string, DailySalesHistoryRow>();
  saleItems.forEach((item) => {
    const sale = activeSalesById.get(item.saleId);
    if (!sale) return;
    const product = productsById.get(item.productId);
    const isTobacco = product?.categoryKind === "tobacco";
    const unitLabel = isTobacco ? "克" : item.unitLabelSnapshot ?? (item.unitType === "carton" ? "条" : "包");
    const quantity = isTobacco ? item.unitsInPacks * item.quantity : item.quantity;
    const date = localDateKey(new Date(sale.completedAt));
    const row = rows.get(date) ?? { date, totals: {} };
    row.totals[unitLabel] = (row.totals[unitLabel] ?? 0) + quantity;
    rows.set(date, row);
  });
  return Array.from(rows.values()).sort((a, b) => b.date.localeCompare(a.date));
};

type MetricComparison = { value: string; arrow: "↑" | "↓" | "→"; tone: "up" | "down" | "same" };

const compareMetric = (current: number, previous: number): MetricComparison => {
  if (previous === 0) return current === 0 ? { value: "0%", arrow: "→", tone: "same" } : { value: "—", arrow: "↑", tone: "up" };
  const change = Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  if (change === 0) return { value: "0%", arrow: "→", tone: "same" };
  return { value: `${change > 0 ? "+" : ""}${change}%`, arrow: change > 0 ? "↑" : "↓", tone: change > 0 ? "up" : "down" };
};

function useAppData() {
  const [data, setData] = useState<AppSnapshot | null>(null);
  const [sync, setSync] = useState<SyncViewState>(EMPTY_SYNC);
  const [backupReminder, setBackupReminder] = useState<BackupReminderDue | null>(null);
  const [error, setError] = useState<string>();
  const initialized = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setData(await repository.snapshot());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取本机数据。");
    }
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    let active = true;
    let stopAutomaticBackups: (() => void) | undefined;
    const unsubscribeData = repository.subscribe(() => void refresh());
    const unsubscribeSync = syncService.subscribe((next) => active && setSync(next));
    const onOnline = () => void syncService.handleOnline();
    const onOffline = () => syncService.handleOffline();
    const onVisible = () => document.visibilityState === "visible" && void syncService.handleOnline();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);

    void (async () => {
      try {
        const invitedSecret = pairingSecretFromLocation();
        const identity = await repository.initialize(invitedSecret);
        clearPairingSecretFromLocation();
        if (!active) return;
        await refresh();
        stopAutomaticBackups = startAutomaticBackups();
        setBackupReminder(await checkBackupReminder());
        await syncService.start(identity.pairing.secret, identity.device);
        if (identity.inviteIgnored) setError("此设备已连接到另一组数据，邀请链接未被应用。");
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Project One 无法启动。");
      }
    })();

    return () => {
      active = false;
      unsubscribeData();
      unsubscribeSync();
      stopAutomaticBackups?.();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      syncService.stop();
    };
  }, [refresh]);

  return { data, sync, error, backupReminder, clearBackupReminder: () => setBackupReminder(null), clearError: () => setError(undefined), refresh };
}

export function App() {
  const { data, sync, error, backupReminder, clearBackupReminder, clearError } = useAppData();
  const [tab, setTab] = useState<Tab>("today");
  const [notice, setNotice] = useState<Notice>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [categoryEditorOpen, setCategoryEditorOpen] = useState(false);
  const [supplierEditorOpen, setSupplierEditorOpen] = useState(false);
  const [productEditor, setProductEditor] = useState<Product | "new" | null>(null);
  const [restockProduct, setRestockProduct] = useState<Product | null>(null);
  const [countProduct, setCountProduct] = useState<Product | null>(null);
  const [movementProduct, setMovementProduct] = useState<Product | null>(null);
  const [restockHistoryOpen, setRestockHistoryOpen] = useState(false);
  const [saleDetail, setSaleDetail] = useState<Sale | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [cartTotalEditorOpen, setCartTotalEditorOpen] = useState(false);
  const [turnoverDate, setTurnoverDate] = useState<string | null>(null);
  const [turnoverField, setTurnoverField] = useState<TurnoverField>("cash");

  const notify = (message: string, kind: Notice["kind"] = "success") => {
    setNotice({ message, kind });
    window.setTimeout(() => setNotice(undefined), 2600);
  };

  const mutate = async (action: () => Promise<unknown>, message?: string) => {
    try {
      await action();
      await syncService.notifyLocalChange();
      if (message) notify(message);
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "操作没有完成，请重试。", "error");
      return false;
    }
  };

  const openTurnoverEditor = (date: string, field: TurnoverField = "cash") => {
    setTurnoverField(field);
    setTurnoverDate(date);
  };

  if (!data) {
    return (
      <main className="launch-screen">
        <div className="launch-mark">P1</div>
        <h1>Project One</h1>
        <p>{error ?? "正在打开本机数据…"}</p>
      </main>
    );
  }

  const currency = "$";
  const cartTotals = calculateCart(data);

  return (
    <>
      <div className="app-shell">
      <main className={`page-content ${tab === "today" ? "today-page" : ""} ${data.cart.items.length ? "has-cart" : ""}`}>
        {tab === "today" && (
          <TodayPage
            data={data}
            sync={sync}
            currency={currency}
          onSettings={() => setSettingsOpen(true)}
          onAdd={(id, unit) => void mutate(() => repository.addToCart(id, unit))}
          onMove={(id, direction) => void mutate(() => repository.moveProduct(id, direction))}
          onAddProduct={() => { setTab("products"); setProductEditor("new"); }}
          onSale={setSaleDetail}
          />
        )}
        {tab === "history" && <HistoryPage data={data} currency={currency} onSale={setSaleDetail} />}
        {tab === "inventory" && (
          <InventoryPage data={data} currency={currency} onRestock={setRestockProduct} onCount={setCountProduct} onHistory={setMovementProduct} onSuppliers={() => setSupplierEditorOpen(true)} onRestockHistory={() => setRestockHistoryOpen(true)} />
        )}
        {tab === "products" && (
          <ProductsPage data={data} currency={currency} onAdd={() => setProductEditor("new")} onEdit={setProductEditor} onCategories={() => setCategoryEditorOpen(true)} />
        )}
        {tab === "turnover" && <TurnoverPage data={data} currency={currency} onEdit={openTurnoverEditor} />}
      </main>

      {data.cart.items.length > 0 && (
        <div className="cart-dock" role="region" aria-label="当前本单">
          <button className="cancel-cart-button" type="button" onClick={() => void mutate(() => repository.clearCart(), "本单已取消").then((ok) => ok && setCartOpen(false))}>取消</button>
          <div className="cart-summary">
            <button className="cart-summary-count" type="button" onClick={() => setCartOpen(true)}>{cartTotals.itemCount} 件</button>
            <button className="cart-summary-total" type="button" onClick={() => setCartTotalEditorOpen(true)} aria-label="修改本单总金额"><strong>{formatMoney(cartTotals.revenueCents, currency)}</strong><span>修改</span></button>
          </div>
          <button
            className="complete-button"
            onClick={() => void mutate(() => repository.completeSale(), "本单已完成").then((ok) => ok && setCartOpen(false))}
          >
            完成
          </button>
        </div>
      )}

      <BottomNav active={tab} onChange={setTab} />

      {settingsOpen && <SettingsSheet data={data} sync={sync} onClose={() => setSettingsOpen(false)} onNotice={notify} />}
      {backupReminder && <BackupReminderSheet onClose={clearBackupReminder} onNotice={notify} onExport={() => downloadBackupFile("project-one-weekly-backup")} />}
      {categoryEditorOpen && <CategorySheet data={data} onClose={() => setCategoryEditorOpen(false)} onAdd={(input) => mutate(() => repository.createCategory(input), "类别已新增")} onDelete={(id) => mutate(() => repository.deleteCategory(id), "类别已删除")} />}
      {supplierEditorOpen && <SupplierSheet data={data} onClose={() => setSupplierEditorOpen(false)} onAdd={(name) => mutate(() => repository.createSupplier(name), "供应商已新增")} onDelete={(id) => mutate(() => repository.deleteSupplier(id), "供应商已删除")} />}
      {restockHistoryOpen && <RestockHistorySheet data={data} currency={currency} onClose={() => setRestockHistoryOpen(false)} />}
      {productEditor && (
        <ProductSheet
          product={productEditor === "new" ? undefined : productEditor}
          data={data}
          onClose={() => setProductEditor(null)}
          onSave={(input, id) => mutate(() => repository.saveProduct(input, id), id ? "商品已更新" : "商品已新增").then((ok) => ok && setProductEditor(null))}
          onToggle={(product) => mutate(() => repository.setProductActive(product.id, !product.active), product.active ? "商品已停用" : "商品已启用")}
          onDelete={(product) => mutate(() => repository.deleteProduct(product.id), "商品已删除").then((ok) => ok && setProductEditor(null))}
        />
      )}
      {restockProduct && (
        <RestockSheet product={restockProduct} suppliers={data.suppliers} onClose={() => setRestockProduct(null)} onSave={(input) => mutate(() => repository.restock(input), "库存已入账").then((ok) => ok && setRestockProduct(null))} />
      )}
      {countProduct && <CountSheet product={countProduct} currentStock={stockMap(data.inventoryMovements, data.products).get(countProduct.id) ?? 0} onClose={() => setCountProduct(null)} onSave={(actualStock, note) => mutate(() => repository.countStock(countProduct.id, actualStock, note), "盘点已完成").then((ok) => ok && setCountProduct(null))} />}
      {movementProduct && <MovementSheet product={movementProduct} products={data.products} movements={data.inventoryMovements} suppliers={data.suppliers} onClose={() => setMovementProduct(null)} onAdjust={(delta, note) => mutate(() => repository.adjustStock(movementProduct.id, delta, note), "库存调整已记录")} />}
      {cartTotalEditorOpen && <CartTotalSheet totalCents={cartTotals.revenueCents} itemCount={cartTotals.itemCount} currency={currency} onClose={() => setCartTotalEditorOpen(false)} onSave={(totalCents) => mutate(() => repository.setCartTotal(totalCents), "本单总金额已修改").then((ok) => ok && setCartTotalEditorOpen(false))} />}
      {turnoverDate && <DailyTurnoverSheet date={turnoverDate} turnover={data.dailyTurnovers.find((item) => item.businessDate === turnoverDate)} initialField={turnoverField} currency={currency} onClose={() => setTurnoverDate(null)} onSave={(input) => mutate(() => repository.saveDailyTurnover(input), "营业额已保存").then((ok) => ok && setTurnoverDate(null))} />}
      {saleDetail && (
        <SaleSheet
          sale={data.sales.find((sale) => sale.id === saleDetail.id) ?? saleDetail}
          items={data.saleItems.filter((item) => item.saleId === saleDetail.id)}
          currency={currency}
          onClose={() => setSaleDetail(null)}
          onVoid={() => mutate(() => repository.voidSale(saleDetail.id), "交易已作废，库存已恢复").then((ok) => ok && setSaleDetail(null))}
          onEditPrice={async (itemId, priceCents) => {
            const saleId = saleDetail.id;
            const ok = await mutate(() => repository.updateSaleItemPrice(saleId, itemId, priceCents), "成交价已更新");
            if (ok) {
              const refreshed = await repository.snapshot();
              setSaleDetail(refreshed.sales.find((sale) => sale.id === saleId) ?? null);
            }
            return ok;
          }}
        />
      )}
      {cartOpen && <CartSheet data={data} currency={currency} onClose={() => setCartOpen(false)} onMutate={mutate} />}
      {(notice || error) && (
        <button className={`toast ${(notice?.kind ?? "error")}`} onClick={() => { setNotice(undefined); clearError(); }}>
          {notice?.kind === "success" && <span className="toast-check" aria-hidden="true"><i /></span>}
          <span>{notice?.message ?? error}</span>
        </button>
      )}
      </div>
    </>
  );
}

function TodayPage({ data, sync, currency, onSettings, onAdd, onMove, onAddProduct, onSale }: {
  data: AppSnapshot;
  sync: SyncViewState;
  currency: string;
  onSettings: () => void;
  onAdd: (id: string, unit: UnitType) => void;
  onMove: (id: string, direction: "up" | "down") => void;
  onAddProduct: () => void;
  onSale: (sale: Sale) => void;
}) {
  const [categoryId, setCategoryId] = useState<string>("all");
  const [sorting, setSorting] = useState(false);
  const [breakdownRequest, setBreakdownRequest] = useState<BreakdownRequest | null>(null);
  const [salesHistoryOpen, setSalesHistoryOpen] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const today = new Date();
  const todayKey = localDateKey(today);
  const sales = activeSales(data.sales).filter((sale) => localDateKey(new Date(sale.completedAt)) === todayKey).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = localDateKey(yesterday);
  const yesterdaySales = activeSales(data.sales).filter((sale) => localDateKey(new Date(sale.completedAt)) === yesterdayKey);
  const metrics = summarizeSales(sales, data.saleItems, data.products);
  const yesterdayMetrics = summarizeSales(yesterdaySales, data.saleItems, data.products);
  const unitTotals = Object.entries(metrics.unitTotals).sort(([left], [right]) => {
    const order = ["条", "包"];
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? order.length : leftIndex) - (rightIndex === -1 ? order.length : rightIndex);
    return 0;
  });
  const todaySaleIds = new Set(sales.map((sale) => sale.id));
  const todayItems = data.saleItems.filter((item) => todaySaleIds.has(item.saleId));
  const breakdownRows = breakdownRequest ? buildBreakdownRows(todayItems, data.products, breakdownRequest) : [];
  const breakdownTotal = breakdownRequest?.metric === "quantity"
    ? metrics.unitTotals[breakdownRequest.unitLabel ?? ""] ?? 0
    : breakdownRequest?.metric === "revenue" ? metrics.revenue : breakdownRequest?.metric === "profit" ? metrics.profit : 0;
  const categories = data.categories.filter((category) => category.active && !category.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder);
  const products = data.products
    .filter((product) => product.active && !product.deletedAt && (categoryId === "all" || product.categoryId === categoryId))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const cartQuantities = new Map<string, Record<UnitType, number>>();
  data.cart.items.forEach((item) => {
    const current = cartQuantities.get(item.productId) ?? { pack: 0, carton: 0 };
    current[item.unitType] += item.quantity;
    cartQuantities.set(item.productId, current);
  });
  const costStates = inventoryCostStates(data.inventoryMovements, data.products, data.saleItems);
  const businessOpen = isBusinessOpen(clock);

  return (
    <>
      <header className="today-header">
        <div>
          <p className="today-date">今日 · {formatDateHeading(today)}</p>
        </div>
        <div className="today-header-actions">
          <div className="status-group" aria-label="营业与同步状态">
            <span className={`status-chip ${businessOpen ? "" : "closed"}`} aria-label={`营业时间：每天 06:00 至 19:00，当前${businessOpen ? "营业中" : "打烊"}`}><i />{businessOpen ? "营业中" : "打烊"}</span>
            <SyncBadge state={sync} pending={data.pendingCount} />
          </div>
          <button className="more-button" aria-label="打开设置" onClick={onSettings}><span aria-hidden="true">•••</span></button>
        </div>
      </header>

      <div className="sales-summary-panel" aria-label="销量">
        <div className="sales-summary-heading"><button type="button" className="sales-summary-heading-button" onClick={() => setSalesHistoryOpen(true)} aria-label="查看销量历史">销量</button></div>
        <div className="sales-summary-values">
          {unitTotals.length ? unitTotals.map(([label, quantity]) => <button type="button" className="sales-summary-item sales-summary-button" key={label} onClick={() => setBreakdownRequest({ metric: "quantity", unitLabel: label })} aria-label={`查看${label}销量贡献`}><strong>{quantity}</strong><em>{label}</em></button>) : <span className="sales-summary-zero">0</span>}
        </div>
      </div>

      <section className="metric-grid" aria-label="今日数据">
        <Metric label="销售额" value={formatMoney(metrics.revenue, currency)} comparison={compareMetric(metrics.revenue, yesterdayMetrics.revenue)} onClick={() => setBreakdownRequest({ metric: "revenue" })} />
        <Metric label="毛利" value={formatMoney(metrics.profit, currency)} comparison={compareMetric(metrics.profit, yesterdayMetrics.profit)} onClick={() => setBreakdownRequest({ metric: "profit" })} />
        <Metric label="客户数" value={String(metrics.customers)} comparison={compareMetric(metrics.customers, yesterdayMetrics.customers)} />
      </section>

      <section className="card quick-card">
        {categories.length > 0 && (
          <div className="category-toolbar">
            <div className="category-tabs" role="tablist" aria-label="商品分类">
              <button className={categoryId === "all" ? "active" : ""} onClick={() => setCategoryId("all")}>全部</button>
              {categories.map((category) => (
                <button key={category.id} className={categoryId === category.id ? "active" : ""} onClick={() => setCategoryId(category.id)}>{category.name}</button>
              ))}
            </div>
            <button className="sort-toggle" onClick={() => { if (!sorting) setCategoryId("all"); setSorting((value) => !value); }}>{sorting ? "完成" : "编辑排序"}</button>
          </div>
        )}
        {products.length ? (
          <div className="product-grid">
            {products.map((product) => {
              const cartQuantity = cartQuantities.get(product.id) ?? { pack: 0, carton: 0 };
              return (
                <article className="quick-product" key={product.id}>
                  <div className="product-card-head">
                    <h3>{product.name}</h3>
                    <div>{productHasBundle(product) ? <><span>{productBaseUnitLabel(product)} {formatMoney(product.packSalePriceCents, currency)}</span><span>{productBundleUnitLabel(product)} {formatMoney(product.cartonSalePriceCents, currency)}</span></> : <span>{productBaseUnitLabel(product)} {formatMoney(product.packSalePriceCents, currency)}</span>}</div>
                  </div>
                  <p className="cost-line">当前平均成本/{product.categoryKind === "tobacco" ? "公斤" : productHasBundle(product) ? productBundleUnitLabel(product) : productBaseUnitLabel(product)} {formatMoney(displayCostCentsAtAverage(product, costStates), currency)}</p>
                  {sorting ? (
                    <div className="sort-actions">
                      <button disabled={products.findIndex((item) => item.id === product.id) === 0} onClick={() => onMove(product.id, "up")}>↑ 上移</button>
                      <button disabled={products.findIndex((item) => item.id === product.id) === products.length - 1} onClick={() => onMove(product.id, "down")}>↓ 下移</button>
                    </div>
                  ) : (
                    <div className="quick-actions">
                      {productHasBundle(product) && <QuickAddButton label={`+1${productBundleUnitLabel(product)}`} ariaLabel={`添加 1${productBundleUnitLabel(product)}`} count={cartQuantity.carton} onAdd={() => onAdd(product.id, "carton")} />}
                      <QuickAddButton label={`+1${productBaseUnitLabel(product)}`} ariaLabel={`添加 1${productBaseUnitLabel(product)}`} count={cartQuantity.pack} onAdd={() => onAdd(product.id, "pack")} />
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState title="还没有可销售商品" body="先建立第一个商品，之后就能在这里快速记录。" action="新增商品" onAction={onAddProduct} />
        )}
      </section>

      <section className="card recent-card">
        <div className="section-title-row stacked-title"><div><h2>最近交易</h2><strong>今天 {sales.length} 笔</strong></div></div>
        {sales.length ? sales.map((sale) => (
          <SaleRow key={sale.id} sale={sale} items={data.saleItems.filter((item) => item.saleId === sale.id)} currency={currency} onClick={() => onSale(sale)} />
        )) : <p className="empty-inline">今天还没有完成的交易。</p>}
      </section>
      {salesHistoryOpen && <DailySalesHistorySheet data={data} onClose={() => setSalesHistoryOpen(false)} />}
      {breakdownRequest && <BreakdownSheet request={breakdownRequest} rows={breakdownRows} total={breakdownTotal} currency={currency} onClose={() => setBreakdownRequest(null)} />}
    </>
  );
}

function DailySalesHistorySheet({ data, onClose }: { data: AppSnapshot; onClose: () => void }) {
  const rows = buildDailySalesHistory(data.sales, data.saleItems, data.products);
  const unitOrder = ["条", "包", "支", "克"];
  return <Sheet title="销量历史" onClose={onClose}><p className="daily-sales-history-note">按每天汇总，已排除作废交易。</p><div className="daily-sales-history-list">{rows.length ? rows.map((row) => { const date = new Date(`${row.date}T12:00:00`); const totals = Object.entries(row.totals).sort(([left], [right]) => { const leftIndex = unitOrder.indexOf(left); const rightIndex = unitOrder.indexOf(right); return (leftIndex === -1 ? unitOrder.length : leftIndex) - (rightIndex === -1 ? unitOrder.length : rightIndex); }); return <div className="daily-sales-history-row" key={row.date}><div className="daily-sales-history-date"><strong>{date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" })}</strong><small>{row.date}</small></div><div className="daily-sales-history-values">{totals.map(([label, quantity]) => <span key={label}><b>{quantity.toLocaleString("zh-CN")}</b>{label}</span>)}</div></div>; }) : <p className="empty-inline">还没有历史销量。</p>}</div></Sheet>;
}

function BreakdownSheet({ request, rows, total, currency, onClose }: { request: BreakdownRequest; rows: BreakdownRow[]; total: number; currency: string; onClose: () => void }) {
  const isQuantity = request.metric === "quantity";
  const title = isQuantity ? `${request.unitLabel ?? ""}销量贡献` : request.metric === "revenue" ? "销售额贡献" : "毛利贡献";
  const totalLabel = isQuantity ? `${total.toLocaleString("zh-CN")}${request.unitLabel ?? ""}` : formatMoney(total, currency);
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="breakdown-summary">
        <div><span>今日总计</span><strong>{totalLabel}</strong></div>
        <small>按贡献从高到低排列</small>
      </div>
      {rows.length ? (
        <div className="breakdown-list">
          {rows.map((row, index) => {
            const share = total > 0 ? row.value / total : 0;
            const valueLabel = isQuantity ? `${row.value.toLocaleString("zh-CN")}${request.unitLabel ?? ""}` : formatMoney(row.value, currency);
            return (
              <div className="breakdown-row" key={`${row.name}-${index}`}>
                <div className="breakdown-row-main"><span className="breakdown-rank">{index + 1}</span><strong>{row.name}</strong><b>{valueLabel}</b></div>
                <div className="breakdown-row-foot"><span>{total > 0 ? `占比 ${(share * 100).toFixed(1)}%` : "占比 —"}</span><div className="breakdown-share"><i style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }} /></div></div>
              </div>
            );
          })}
        </div>
      ) : <p className="empty-inline">今天还没有可统计的数据。</p>}
    </Sheet>
  );
}

function HistoryPage({ data, currency, onSale }: { data: AppSnapshot; currency: string; onSale: (sale: Sale) => void }) {
  const [mode, setMode] = useState<"transactions" | "analysis">("transactions");
  const [date, setDate] = useState(localDateKey(new Date()));
  return (
    <>
      <PageHeader title="历史" subtitle="交易记录与经营趋势" />
      <Segmented value={mode} options={[{ value: "transactions", label: "交易" }, { value: "analysis", label: "分析" }]} onChange={setMode} />
      {mode === "transactions" ? (
        <section className="card list-card">
          <label className="date-control">日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          {activeSales(data.sales).filter((sale) => localDateKey(new Date(sale.completedAt)) === date).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).map((sale) => (
            <SaleRow key={sale.id} sale={sale} items={data.saleItems.filter((item) => item.saleId === sale.id)} currency={currency} onClick={() => onSale(sale)} />
          ))}
          {!activeSales(data.sales).some((sale) => localDateKey(new Date(sale.completedAt)) === date) && <p className="empty-inline">这一天没有交易。</p>}
        </section>
      ) : <AnalysisView data={data} currency={currency} />}
    </>
  );
}

const dailyTurnoverTotalCents = (turnover: Pick<DailyTurnover, "cashCents" | "posCents" | "lotteryPayoutCents">) =>
  turnover.cashCents + turnover.posCents + turnover.lotteryPayoutCents;

const businessDateLabel = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
const turnoverFieldLabels: Record<TurnoverField, string> = { cash: "现金收入", pos: "POS 收入", lotteryPayout: "彩票兑奖" };
const turnoverDraftValue = (cents: number) => (cents / 100).toFixed(2);

function TurnoverPage({ data, currency, onEdit }: { data: AppSnapshot; currency: string; onEdit: (date: string, field?: TurnoverField) => void }) {
  const [period, setPeriod] = useState<"7d" | "30d">("7d");
  const [todayKey, setTodayKey] = useState(() => localDateKey(new Date()));
  useEffect(() => {
    const refreshBusinessDate = () => {
      const nextKey = localDateKey(new Date());
      setTodayKey((currentKey) => currentKey === nextKey ? currentKey : nextKey);
    };
    refreshBusinessDate();
    const timer = window.setInterval(refreshBusinessDate, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const records = data.dailyTurnovers.filter((turnover) => !turnover.deletedAt).sort((a, b) => b.businessDate.localeCompare(a.businessDate));
  const recordByDate = new Map(records.map((turnover) => [turnover.businessDate, turnover]));
  const today = recordByDate.get(todayKey);
  const todayTotal = today ? dailyTurnoverTotalCents(today) : 0;
  const dayCount = period === "7d" ? 7 : 30;
  const trend = Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(`${todayKey}T12:00:00`);
    date.setDate(date.getDate() - (dayCount - 1 - index));
    const key = localDateKey(date);
    const turnover = recordByDate.get(key);
    return { key, label: `${date.getMonth() + 1}/${date.getDate()}`, turnover, value: turnover ? dailyTurnoverTotalCents(turnover) : 0 };
  });
  const recorded = trend.flatMap((point) => point.turnover ? [point.turnover] : []);
  const periodTotal = recorded.reduce((sum, turnover) => sum + dailyTurnoverTotalCents(turnover), 0);
  const maxTrend = Math.max(1, ...trend.map((point) => Math.max(0, point.value)));
  const periodStart = trend[0]?.key ?? todayKey;
  const history = records.filter((turnover) => turnover.businessDate >= periodStart && turnover.businessDate <= todayKey).slice(0, 12);
  const labelStep = period === "30d" ? 5 : 1;

  return (
    <>
      <PageHeader title="营业额" subtitle="每日结算与营业趋势" />
      <section className="card turnover-summary-card" aria-label="今日营业额">
        <div className="turnover-summary-main">
          <span>今日总营业额</span>
          <small>{today ? `${businessDateLabel(todayKey)} · 已录入` : `${businessDateLabel(todayKey)} · 还未录入`}</small>
          <strong>{formatMoney(todayTotal, currency)}</strong>
        </div>
        <div className="turnover-breakdown-grid">
          <button type="button" className="turnover-breakdown-button" onClick={() => onEdit(todayKey, "cash")}><span>现金收入</span><strong>{formatMoney(today?.cashCents ?? 0, currency)}</strong></button>
          <button type="button" className="turnover-breakdown-button" onClick={() => onEdit(todayKey, "pos")}><span>POS 收入</span><strong>{formatMoney(today?.posCents ?? 0, currency)}</strong></button>
          <button type="button" className="turnover-breakdown-button" onClick={() => onEdit(todayKey, "lotteryPayout")}><span>彩票兑奖</span><strong>{formatMoney(today?.lotteryPayoutCents ?? 0, currency)}</strong></button>
        </div>
      </section>

      <div className="turnover-section-heading"><h2>营业趋势</h2><div className="turnover-period-tabs"><button className={period === "7d" ? "active" : ""} onClick={() => setPeriod("7d")}>7天</button><button className={period === "30d" ? "active" : ""} onClick={() => setPeriod("30d")}>30天</button></div></div>
      <section className="card turnover-chart-card" aria-label={`${period === "7d" ? "最近七天" : "最近三十天"}营业趋势`}>
        <div className="turnover-chart-head"><strong>总营业额</strong><span>{recorded.length ? `已记录 ${recorded.length} 天 · 日均 ${formatMoney(Math.round(periodTotal / recorded.length), currency)}` : "还没有营业额记录"}</span></div>
        <div className={`turnover-bar-chart ${period === "30d" ? "long" : ""}`}>
          {trend.map((point, index) => <div className="turnover-bar-column" key={point.key} title={point.turnover ? `${businessDateLabel(point.key)} ${formatMoney(point.value, currency)}` : `${businessDateLabel(point.key)} 未录入`}><div className={`turnover-bar ${point.turnover ? "" : "empty"} ${point.value < 0 ? "negative" : ""}`} style={{ height: `${point.turnover ? Math.max(5, Math.abs(point.value) / maxTrend * 100) : 4}%` }} /><span>{index % labelStep === 0 || index === trend.length - 1 ? point.label : ""}</span></div>)}
        </div>
      </section>

      <section className="card turnover-history-card">
        <div className="section-title-row"><h2>每日记录</h2><span>{history.length} 天</span></div>
        {history.length ? history.map((turnover) => <button className="turnover-history-row" key={turnover.id} onClick={() => onEdit(turnover.businessDate)}><span><strong>{businessDateLabel(turnover.businessDate)}</strong><small>现金 {formatMoney(turnover.cashCents, currency)} · POS {formatMoney(turnover.posCents, currency)} · 兑奖 {formatMoney(turnover.lotteryPayoutCents, currency)}</small></span><b>{formatMoney(dailyTurnoverTotalCents(turnover), currency)}</b></button>) : <p className="empty-inline">所选期间还没有营业额记录。</p>}
      </section>
    </>
  );
}

function DailyTurnoverSheet({ date, turnover, initialField, currency, onClose, onSave }: { date: string; turnover?: DailyTurnover; initialField: TurnoverField; currency: string; onClose: () => void; onSave: (input: Parameters<typeof repository.saveDailyTurnover>[0]) => Promise<unknown> }) {
  const [activeField, setActiveField] = useState<TurnoverField>(initialField);
  const [replaceMode, setReplaceMode] = useState<Record<TurnoverField, boolean>>({ cash: true, pos: true, lotteryPayout: true });
  const [drafts, setDrafts] = useState<Record<TurnoverField, string>>({
    cash: turnoverDraftValue(turnover?.cashCents ?? 0),
    pos: turnoverDraftValue(turnover?.posCents ?? 0),
    lotteryPayout: turnoverDraftValue(turnover?.lotteryPayoutCents ?? 0),
  });
  const [businessDate, setBusinessDate] = useState(date);
  const [note, setNote] = useState(turnover?.note ?? "");
  const selectField = (field: TurnoverField) => {
    setActiveField(field);
    setReplaceMode((current) => ({ ...current, [field]: true }));
  };
  const updateActiveDraft = (next: string) => {
    setDrafts((current) => ({ ...current, [activeField]: next }));
    setReplaceMode((current) => ({ ...current, [activeField]: false }));
  };
  const handleKeypad = (key: string) => {
    const current = replaceMode[activeField] ? "" : drafts[activeField];
    if (/^\d$/.test(key)) {
      if (current.includes(".") && current.split(".")[1].length >= 2) return;
      updateActiveDraft(current === "0" ? key : `${current}${key}`);
      return;
    }
    if (key === ".") {
      if (current.includes(".")) return;
      updateActiveDraft(current ? `${current}.` : "0.");
      return;
    }
    if (key === "backspace") {
      updateActiveDraft(current.slice(0, -1) || "0");
      return;
    }
    updateActiveDraft("0");
  };
  const liveAmounts = {
    cashCents: centsFromInput(drafts.cash),
    posCents: centsFromInput(drafts.pos),
    lotteryPayoutCents: centsFromInput(drafts.lotteryPayout),
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSave({
      businessDate,
      cashCents: liveAmounts.cashCents,
      posCents: liveAmounts.posCents,
      lotteryPayoutCents: liveAmounts.lotteryPayoutCents,
      note,
    });
  };
  return (
    <Sheet title={turnover ? "编辑营业额" : "录入营业额"} onClose={onClose}>
      <form className="form-stack turnover-form" onSubmit={submit}>
        <div className="turnover-live-total">
          <span>今日总营业额</span>
          <strong>{formatMoney(liveAmounts.cashCents + liveAmounts.posCents + liveAmounts.lotteryPayoutCents, currency)}</strong>
          <small>现金收入 + POS 收入 + 彩票兑奖</small>
        </div>
        <Field label="营业日期"><input name="businessDate" type="date" required value={businessDate} onChange={(event) => setBusinessDate(event.target.value)} /></Field>
        <div className="turnover-entry-fields" aria-label="营业额金额">
          {(["cash", "pos", "lotteryPayout"] as TurnoverField[]).map((field) => (
            <button type="button" className={`turnover-entry-field ${activeField === field ? "active" : ""}`} key={field} onClick={() => selectField(field)}>
              <span>{turnoverFieldLabels[field]}</span>
              <strong>{formatMoney(centsFromInput(drafts[field]), currency)}</strong>
            </button>
          ))}
        </div>
        <div className="turnover-keypad" aria-label="数字键盘">
          <div className="turnover-keypad-head"><span>正在输入：{turnoverFieldLabels[activeField]}</span><strong>{formatMoney(centsFromInput(drafts[activeField]), currency)}</strong></div>
          <div className="turnover-keypad-grid">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"].map((key) => <button type="button" key={key} onClick={() => handleKeypad(key)}>{key}</button>)}
            <button type="button" className="turnover-keypad-backspace" aria-label="删除一位" onClick={() => handleKeypad("backspace")}>⌫</button>
            <button type="button" className="turnover-keypad-clear" onClick={() => handleKeypad("clear")}>清空</button>
          </div>
        </div>
        <button className="primary-button">保存营业额</button>
        <Field label="备注（可不填）"><input name="note" autoComplete="off" value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：当天结算说明" /></Field>
      </form>
    </Sheet>
  );
}

function AnalysisView({ data, currency }: { data: AppSnapshot; currency: string }) {
  const [period, setPeriod] = useState<AnalysisPeriod>("today");
  const [customStart, setCustomStart] = useState(localDateKey(new Date(Date.now() - 6 * 86400000)));
  const [customEnd, setCustomEnd] = useState(localDateKey(new Date()));
  const [ranking, setRanking] = useState<"quantity" | "revenue" | "profit">("quantity");
  const { start, end } = useMemo(() => analysisRange(period, customStart, customEnd), [period, customStart, customEnd]);
  const sales = activeSales(data.sales).filter((sale) => {
    const time = new Date(sale.completedAt).getTime();
    return time >= start.getTime() && time <= end.getTime();
  });
  const saleIds = new Set(sales.map((sale) => sale.id));
  const items = data.saleItems.filter((item) => saleIds.has(item.saleId));
  const metrics = summarizeSales(sales, data.saleItems, data.products);
  const trend = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(end);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    const key = localDateKey(date);
    return { key, label: `${date.getMonth() + 1}/${date.getDate()}`, value: sales.filter((sale) => localDateKey(new Date(sale.completedAt)) === key).reduce((sum, sale) => sum + sale.revenueCents, 0) };
  });
  const maxTrend = Math.max(1, ...trend.map((point) => point.value));
  const ranks = Array.from(items.reduce((map, item) => {
    const current = map.get(item.productId) ?? { name: item.productNameSnapshot, unitLabel: item.unitLabelSnapshot ?? (item.unitType === "carton" ? "条" : "包"), quantity: 0, revenue: 0, profit: 0 };
    current.quantity += item.unitsInPacks * item.quantity;
    current.revenue += item.lineRevenueCents;
    current.profit += item.lineProfitCents;
    map.set(item.productId, current);
    return map;
  }, new Map<string, { name: string; unitLabel: string; quantity: number; revenue: number; profit: number }>()).values()).sort((a, b) => b[ranking] - a[ranking]).slice(0, 5);

  return (
    <div className="analysis-stack">
      <div className="period-tabs">
        {([['today', '今日'], ['7d', '7天'], ['30d', '30天'], ['month', '按月'], ['custom', '自定义']] as [AnalysisPeriod, string][]).map(([value, label]) => (
          <button key={value} className={period === value ? "active" : ""} onClick={() => setPeriod(value)}>{label}</button>
        ))}
      </div>
      {period === "custom" && <div className="custom-dates"><input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} /><span>至</span><input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} /></div>}
      <section className="card analysis-metrics">
        <Metric label="销售额" value={formatMoney(metrics.revenue, currency)} />
        <Metric label="毛利" value={formatMoney(metrics.profit, currency)} />
        <Metric label="客户数" value={String(metrics.customers)} />
        <Metric label="售出数量" value={Object.entries(metrics.unitTotals).map(([label, quantity]) => `${quantity}${label}`).join(" · ") || "0"} />
      </section>
      <section className="card chart-card">
        <h2>销售趋势</h2>
        <div className="bar-chart" aria-label="最近七天销售趋势">
          {trend.map((point) => <div className="bar-column" key={point.key}><div className="bar" style={{ height: `${Math.max(4, point.value / maxTrend * 100)}%` }} /><span>{point.label}</span></div>)}
        </div>
      </section>
      <section className="card ranking-card">
        <div className="section-title-row"><h2>畅销商品</h2><select value={ranking} onChange={(e) => setRanking(e.target.value as typeof ranking)}><option value="quantity">按销量</option><option value="revenue">按销售额</option><option value="profit">按毛利</option></select></div>
        {ranks.length ? ranks.map((item, index) => <div className="rank-row" key={item.name}><span>{index + 1}</span><strong>{item.name}</strong><em>{ranking === "quantity" ? `${item.quantity} ${item.unitLabel}` : formatMoney(item[ranking], currency)}</em></div>) : <p className="empty-inline">所选时段还没有数据。</p>}
      </section>
    </div>
  );
}

function InventoryPage({ data, currency, onRestock, onCount, onHistory, onSuppliers, onRestockHistory }: { data: AppSnapshot; currency: string; onRestock: (product: Product) => void; onCount: (product: Product) => void; onHistory: (product: Product) => void; onSuppliers: () => void; onRestockHistory: () => void }) {
  const stocks = stockMap(data.inventoryMovements, data.products);
  const costStates = inventoryCostStates(data.inventoryMovements, data.products, data.saleItems);
  const visibleProducts = data.products.filter((product) => !product.deletedAt);
  const tobaccoProducts = visibleProducts.filter((product) => product.categoryKind === "tobacco");
  const tobaccoThreshold = tobaccoProducts.reduce((threshold, product) => Math.max(threshold, product.lowStockThresholdPacks), 0);
  const inventoryProducts = [
    ...visibleProducts.filter((product) => product.categoryKind !== "tobacco"),
    ...(tobaccoProducts.length ? [{ ...tobaccoProducts[0], name: "烟丝（共享库存）", lowStockThresholdPacks: tobaccoThreshold }] : []),
  ].sort((a, b) => {
    const aLow = (stocks.get(a.id) ?? 0) <= a.lowStockThresholdPacks ? 0 : 1;
    const bLow = (stocks.get(b.id) ?? 0) <= b.lowStockThresholdPacks ? 0 : 1;
    return aLow - bLow || a.name.localeCompare(b.name);
  });
  const lowCount = inventoryProducts.filter((product) => (stocks.get(product.id) ?? 0) <= product.lowStockThresholdPacks).length;
  const inventoryValue = inventoryProducts.reduce((total, product) => total + inventoryValueCentsAtAverage(stocks.get(product.id) ?? 0, product, costStates), 0);
  return (
    <>
      <PageHeader title="库存" subtitle={lowCount ? `${lowCount} 项需要留意` : "库存状态正常"} action={<div className="page-header-actions"><button className="secondary-button" onClick={onRestockHistory}>补货记录</button><button className="secondary-button" onClick={onSuppliers}>供应商管理</button></div>} />
      <section className="inventory-summary" aria-label="库存统计">
        <div className="inventory-summary-heading"><span>库存总货值</span><small>按成本价估算 · 当前库存</small></div>
        <strong>{formatMoney(inventoryValue, currency)}</strong>
      </section>
      <section className="card list-card">
        {inventoryProducts.map((product) => {
          const stock = stocks.get(product.id) ?? 0;
          const low = stock <= product.lowStockThresholdPacks;
          const value = inventoryValueCentsAtAverage(stock, product, costStates);
          return <article className="inventory-row" key={product.id}>
                  <button className="inventory-main" onClick={() => onHistory(product)}><strong>{product.name}</strong><div className="inventory-stock-line"><span className={stock < 0 ? "danger-text" : low ? "warning-text" : ""}>{formatProductStock(stock, product)}</span><strong>库存货值 {formatMoney(value, currency)}</strong></div><small>{product.categoryKind === "tobacco" ? `规格 ${formatTobaccoSpec(product.unitWeightGrams)} · 最低库存 ${(product.lowStockThresholdPacks / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 })} 公斤` : `最低库存 ${productHasBundle(product) ? `${thresholdCartons(product.lowStockThresholdPacks, product.packsPerCarton)} ${productBundleUnitLabel(product)}` : `${product.lowStockThresholdPacks} ${productBaseUnitLabel(product)}`}`}</small></button>
            <div className="inventory-actions"><button className="secondary-button" onClick={() => onCount(product)}>盘点</button><button className="secondary-button" onClick={() => onRestock(product)}>补货</button></div>
          </article>;
        })}
        {!inventoryProducts.length && <EmptyState title="还没有库存项目" body="新增商品时可以录入期初库存。" />}
      </section>
    </>
  );
}

function ProductsPage({ data, currency, onAdd, onEdit, onCategories }: { data: AppSnapshot; currency: string; onAdd: () => void; onEdit: (product: Product) => void; onCategories: () => void }) {
  const stocks = stockMap(data.inventoryMovements, data.products);
  const costStates = inventoryCostStates(data.inventoryMovements, data.products, data.saleItems);
  const products = data.products.filter((product) => !product.deletedAt).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  return (
    <>
      <PageHeader title="商品" subtitle={`${products.filter((product) => product.active).length} 个在售商品`} action={<div className="page-header-actions"><button className="primary-small" onClick={onCategories}>编辑分类</button><button className="primary-small" onClick={onAdd}>添加商品</button></div>} />
      <section className="card list-card products-list">
        {products.map((product) => <button className={`product-row ${product.active ? "" : "inactive"}`} key={product.id} onClick={() => onEdit(product)}>
          <div><strong>{product.name}</strong><span>{categoryName(product, data.categories)}{product.categoryKind === "tobacco" ? ` · ${formatTobaccoSpec(product.unitWeightGrams)}` : ""} · {product.active ? "在售" : "已停用"}</span></div>
          <div><strong>{product.categoryKind === "tobacco" ? `售价 ${formatMoney(product.packSalePriceCents, currency)}` : productHasBundle(product) ? `${productBaseUnitLabel(product)} ${formatMoney(product.packSalePriceCents, currency)} · ${productBundleUnitLabel(product)} ${formatMoney(product.cartonSalePriceCents, currency)}` : `${productBaseUnitLabel(product)} ${formatMoney(product.packSalePriceCents, currency)}`}</strong><span>当前平均成本 {formatMoney(displayCostCentsAtAverage(product, costStates), currency)} / {product.categoryKind === "tobacco" ? "公斤" : productHasBundle(product) ? productBundleUnitLabel(product) : productBaseUnitLabel(product)} · {formatProductStock(stocks.get(product.id) ?? 0, product)}</span></div>
        </button>)}
        {!products.length && <EmptyState title="从第一个商品开始" body="真实商品资料只会保存在这台设备中。" action="新增商品" onAction={onAdd} />}
      </section>
    </>
  );
}

function BottomNav({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  const items: { id: Tab; icon: string; label: string }[] = [
    { id: "today", icon: "✓", label: "今日" }, { id: "history", icon: "◷", label: "历史" }, { id: "inventory", icon: "▦", label: "库存" }, { id: "products", icon: "◇", label: "商品" }, { id: "turnover", icon: "$", label: "营业额" },
  ];
  return <nav className="bottom-nav">{items.map((item) => <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => onChange(item.id)}><span>{item.icon}</span>{item.label}</button>)}</nav>;
}

function PageHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</header>;
}

function Metric({ label, value, comparison, onClick }: { label: string; value: string; comparison?: MetricComparison; onClick?: () => void }) {
  const content = (
    <>
      <div className="metric-head">
        <span>{label}</span>
        {comparison && <div className={`metric-compare ${comparison.tone}`}><small>昨日同期</small><strong>{comparison.value} {comparison.arrow}</strong></div>}
      </div>
      <strong className={`metric-value${value.length > 16 ? " metric-value-compact metric-value-extra-compact" : value.length > 10 ? " metric-value-compact" : ""}`}>{value}</strong>
    </>
  );
  return onClick ? <button type="button" className="metric metric-button" onClick={onClick}>{content}</button> : <div className="metric">{content}</div>;
}

function SyncBadge({ state, pending }: { state: SyncViewState; pending: number }) {
  const map: Record<SyncViewState["status"], string> = { connected: "已连接", syncing: "同步中", pending: pending ? "待同步" : "等待连接", offline: "离线", local: "本机", connecting: "连接中", error: "待同步" };
  return <span className={`sync-badge ${state.status}`}><i />{map[state.status]}</span>;
}

function SaleRow({ sale, items, currency, onClick }: { sale: Sale; items: SaleItem[]; currency: string; onClick: () => void }) {
  return <button className="sale-row" onClick={onClick}><time>{formatTime(sale.completedAt)}</time><div><strong>{saleSummary(items) || "交易记录"}</strong><span>毛利 {formatMoney(sale.profitCents, currency)} · 销售：{sale.deviceLabelSnapshot ?? "本机"}</span></div><b>{formatMoney(sale.revenueCents, currency)}</b></button>;
}

function QuickAddButton({ label, ariaLabel, count, onAdd }: { label: string; ariaLabel: string; count: number; onAdd: () => void }) {
  const badge = count > 0 ? <span className="quick-add-badge" aria-hidden="true">{count}</span> : null;
  return <button type="button" onClick={onAdd} aria-label={ariaLabel}>{label}{badge}</button>;
}

function EmptyState({ title, body, action, onAction }: { title: string; body: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><strong>{title}</strong><p>{body}</p>{action && onAction && <button className="primary-small" data-testid="empty-action" onClick={onAction}>{action}</button>}</div>;
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return <div className="segmented">{options.map((option) => <button className={value === option.value ? "active" : ""} key={option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

function Sheet({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`sheet ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button aria-label="关闭" onClick={onClose}>×</button></header><div className="sheet-body">{children}</div></section></div>;
}

function ProductSheet({ product, data, onClose, onSave, onToggle, onDelete }: {
  product?: Product;
  data: AppSnapshot;
  onClose: () => void;
  onSave: (input: Parameters<typeof repository.saveProduct>[0], id?: string) => Promise<unknown>;
  onToggle: (product: Product) => Promise<unknown>;
  onDelete: (product: Product) => Promise<unknown>;
}) {
  const category = product ? data.categories.find((item) => item.id === product.categoryId)?.name : "";
  const categoryOptions = data.categories.filter((item) => !item.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const costStates = inventoryCostStates(data.inventoryMovements, data.products, data.saleItems);
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? categoryOptions[0]?.id ?? "");
  const selectedCategory = data.categories.find((item) => item.id === categoryId) ?? data.categories.find((item) => item.id === product?.categoryId);
  const kind = selectedCategory?.kind ?? product?.categoryKind;
  const tobacco = kind === "tobacco";
  const baseLabel = selectedCategory?.baseUnitLabel ?? product?.baseUnitLabel ?? (kind === "vape" ? "支" : tobacco ? "件" : kind === "cigarette" ? "包" : "单位");
  const bundleLabel = selectedCategory?.bundleUnitLabel ?? product?.bundleUnitLabel ?? (kind === "cigarette" ? "条" : baseLabel);
  const hasBundle = !tobacco && (
    kind === "cigarette" ||
    (selectedCategory?.unitsPerBundle ?? product?.packsPerCarton ?? 1) > 1 ||
    (Boolean(selectedCategory?.bundleUnitLabel ?? product?.bundleUnitLabel) && bundleLabel !== baseLabel)
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const packsPerCarton = hasBundle ? Math.max(1, numberFromInput(form.get("packsPerCarton")) || selectedCategory?.unitsPerBundle || product?.packsPerCarton || 1) : 1;
    const selectedCategoryId = String(form.get("categoryId") ?? categoryId);
    const selectedCategoryRecord = data.categories.find((item) => item.id === selectedCategoryId);
    const selectedCategoryName = selectedCategoryRecord?.name ?? String(form.get("categoryName") ?? "");
    const selectedKind = selectedCategoryRecord?.kind ?? kind;
    const basePrice = centsFromInput(form.get("packPrice"));
    const bundlePrice = hasBundle ? centsFromInput(form.get("cartonPrice")) : basePrice;
    const tobaccoProduct = selectedKind === "tobacco";
    const enteredName = String(form.get("name") ?? "");
    const enteredWeightGrams = optionalNumberFromInput(form.get("unitWeightGrams"));
    const unitWeightGrams = tobaccoProduct ? enteredWeightGrams ?? weightFromNameInput(enteredName) ?? product?.unitWeightGrams : undefined;
    const lowStockValue = tobaccoProduct ? optionalDecimalFromInput(form.get("lowStockCartons")) : optionalNumberFromInput(form.get("lowStockCartons"));
    const openingValue = tobaccoProduct ? (optionalDecimalFromInput(form.get("openingPacks")) ?? 0) : numberFromInput(form.get("openingPacks"));
    void onSave({
      name: String(form.get("name") ?? ""), categoryName: selectedCategoryName, categoryKind: selectedKind, baseUnitLabel: tobaccoProduct ? "件" : selectedCategoryRecord?.baseUnitLabel ?? product?.baseUnitLabel ?? (selectedKind === "vape" ? "支" : selectedKind === "cigarette" ? "包" : "单位"), bundleUnitLabel: tobaccoProduct ? "件" : selectedCategoryRecord?.bundleUnitLabel ?? product?.bundleUnitLabel ?? (selectedKind === "cigarette" ? "条" : baseLabel), categoryUnitsPerBundle: selectedCategoryRecord?.unitsPerBundle, unitWeightGrams, packSalePriceCents: basePrice, cartonSalePriceCents: hasBundle ? bundlePrice : basePrice, openingCostCents: product ? undefined : optionalCentsFromInput(form.get("openingCost")), packsPerCarton: tobaccoProduct ? 1 : packsPerCarton, lowStockThresholdCartons: tobaccoProduct ? undefined : lowStockValue, lowStockThresholdPacks: tobaccoProduct ? (lowStockValue ?? 0) * 1000 : undefined, openingStockPacks: tobaccoProduct ? openingValue * 1000 : numberFromInput(form.get("openingCartons")) * packsPerCarton + openingValue,
    }, product?.id);
  };
  return <Sheet title={product ? "编辑商品" : "新增商品"} onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <Field label={tobacco ? "商品名称（含规格）" : "商品名称"}><input name="name" required defaultValue={product?.name} placeholder={tobacco ? "例如：烟丝 50克" : undefined} autoComplete="off" /></Field>
    <Field label="分类">{categoryOptions.length ? <select name="categoryId" required value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="" disabled>请选择分类</option>{categoryOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : <input name="categoryName" required defaultValue={category} placeholder="例如 Category A" autoComplete="off" />}</Field>
    {tobacco && <Field label="每件规格（克）"><input name="unitWeightGrams" type="number" inputMode="numeric" min="1" step="1" required={!product} defaultValue={product?.unitWeightGrams ?? weightFromNameInput(product?.name ?? "") ?? ""} placeholder="例如 25、50、1000" /></Field>}
    {tobacco ? <Field label="售价"><MoneyInput name="packPrice" cents={product?.packSalePriceCents} /></Field> : hasBundle ? <div className="form-grid"><Field label={`${baseLabel}售价`}><MoneyInput name="packPrice" cents={product?.packSalePriceCents} /></Field><Field label={`${bundleLabel}售价`}><MoneyInput name="cartonPrice" cents={product?.cartonSalePriceCents} /></Field></div> : <Field label={`${baseLabel}售价`}><MoneyInput name="packPrice" cents={product?.packSalePriceCents} /></Field>}
    {product ? <div className="readonly-cost-field"><span>当前平均成本</span><strong>{formatMoney(displayCostCentsAtAverage(product, costStates), "$")}</strong><small>由期初库存和每次补货自动计算，不能在商品资料里直接修改。</small></div> : <Field label="期初库存总成本（可不填）"><MoneyInput name="openingCost" required={false} /></Field>}
    {!tobacco && hasBundle && <Field label={`${bundleLabel}包含多少${baseLabel}`}><input name="packsPerCarton" type="number" inputMode="numeric" min="1" required={kind === "cigarette"} placeholder="可不填" defaultValue={product?.packsPerCarton ?? selectedCategory?.unitsPerBundle ?? 10} /></Field>}
    <Field label={tobacco ? "低库存提醒（公斤）" : `低库存提醒（${hasBundle ? bundleLabel : baseLabel}）`}><input name="lowStockCartons" type="number" inputMode="decimal" min="0" step="0.001" placeholder="可不填" defaultValue={product ? (tobacco ? (product.lowStockThresholdPacks / 1000 || "") : hasBundle ? thresholdCartons(product.lowStockThresholdPacks, product.packsPerCarton) : product.lowStockThresholdPacks) : ""} /></Field>
    {!product && (tobacco ? <Field label="期初库存（公斤）"><input name="openingPacks" type="number" inputMode="decimal" min="0" step="0.001" placeholder="可不填" /></Field> : hasBundle ? <div className="form-grid"><Field label={`期初库存（${bundleLabel}）`}><input name="openingCartons" type="number" inputMode="numeric" min="0" placeholder="可不填" /></Field><Field label={`另外（${baseLabel}）`}><input name="openingPacks" type="number" inputMode="numeric" min="0" placeholder="可不填" /></Field></div> : <Field label={`期初库存（${baseLabel}）`}><input name="openingPacks" type="number" inputMode="numeric" min="0" placeholder="可不填" /></Field>)}
    <button className="primary-button" type="submit">{product ? "保存修改" : "新增商品"}</button>
    {product && <button className="text-danger" type="button" onClick={() => void onToggle(product)}>{product.active ? "停用这个商品" : "重新启用商品"}</button>}
    {product && <button className="text-danger" type="button" onClick={() => window.confirm("确定删除这个商品吗？历史销售记录会保留。") && void onDelete(product)}>删除这个商品</button>}
  </form></Sheet>;
}

function CategorySheet({ data, onClose, onAdd, onDelete }: {
  data: AppSnapshot;
  onClose: () => void;
  onAdd: (input: { name: string; baseUnitLabel?: string; bundleUnitLabel?: string; unitsPerBundle?: number }) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const categories = data.categories.filter((category) => category.kind && !category.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const customCategories = data.categories.filter((category) => !category.kind && !category.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  return <Sheet title="编辑分类" onClose={onClose}>
    <p className="privacy-note category-note">以下三类为系统内置分类。你也可以添加自定义分类，单位属性全部可以留空。</p>
    <div className="category-editor-list">
      {categories.map((category) => <div className="category-editor-row" key={category.id}>
        <input aria-label={`类别 ${category.name}`} value={category.name} readOnly />
        <span className="secondary-button category-fixed-badge">内置</span>
      </div>)}
      {!categories.length && <p className="empty-inline">内置分类正在准备中。</p>}
    </div>
    {customCategories.length > 0 && <div className="category-custom-list"><p className="category-subtitle">自定义分类</p>{customCategories.map((category) => <div className="category-editor-row" key={category.id}>
      <input aria-label={`类别 ${category.name}`} value={category.name} readOnly />
      <button className="text-danger" type="button" onClick={() => window.confirm(`确定删除类别“${category.name}”吗？现有商品和历史记录会保留。`) && void onDelete(category.id)}>删除</button>
    </div>)}</div>}
    <form className="category-create-form category-add-form" onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = String(form.get("categoryName") ?? "").trim();
      if (!name) return;
      const baseUnitLabel = String(form.get("baseUnitLabel") ?? "").trim() || undefined;
      const bundleUnitLabel = String(form.get("bundleUnitLabel") ?? "").trim() || undefined;
      const units = Number(form.get("unitsPerBundle"));
      void onAdd({ name, baseUnitLabel, bundleUnitLabel, unitsPerBundle: Number.isFinite(units) && units > 0 ? Math.round(units) : undefined }).then((ok) => { if (ok) event.currentTarget.reset(); });
    }}>
      <p className="category-subtitle">添加自定义分类</p>
      <Field label="分类名称"><input name="categoryName" required maxLength={40} placeholder="例如 配件、礼盒" /></Field>
      <div className="form-grid"><Field label="基础单位（可不填）"><input name="baseUnitLabel" maxLength={12} placeholder="例如 件、支、克" /></Field><Field label="组合单位（可不填）"><input name="bundleUnitLabel" maxLength={12} placeholder="例如 盒、箱" /></Field></div>
      <Field label="每组合数量（可不填）"><input name="unitsPerBundle" type="number" inputMode="numeric" min="1" placeholder="例如 10" /></Field>
      <button className="primary-small" type="submit">添加分类</button>
    </form>
  </Sheet>;
}

function SupplierSheet({ data, onClose, onAdd, onDelete }: {
  data: AppSnapshot;
  onClose: () => void;
  onAdd: (name: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const suppliers = data.suppliers.filter((supplier) => !supplier.deletedAt).sort((a, b) => a.name.localeCompare(b.name));
  const [newName, setNewName] = useState("");
  return <Sheet title="供应商管理" onClose={onClose}>
    <p className="privacy-note supplier-note">供应商名称只保存在本机，可用于之后的进货记录。</p>
    <form className="supplier-create-form" onSubmit={(event) => { event.preventDefault(); const name = newName.trim(); if (!name) return; void onAdd(name).then((ok) => ok && setNewName("")); }}>
      <input value={newName} maxLength={60} placeholder="输入供应商名称" onChange={(event) => setNewName(event.target.value)} />
      <button className="primary-small" type="submit">新增</button>
    </form>
    <div className="supplier-list">
      {suppliers.map((supplier) => <div className="supplier-row" key={supplier.id}><strong>{supplier.name}</strong><button className="text-danger" type="button" onClick={() => window.confirm(`确定删除供应商“${supplier.name}”吗？`) && void onDelete(supplier.id)}>删除</button></div>)}
      {!suppliers.length && <p className="empty-inline">还没有供应商。</p>}
    </div>
  </Sheet>;
}

function RestockSheet({ product, suppliers, onClose, onSave }: { product: Product; suppliers: AppSnapshot["suppliers"]; onClose: () => void; onSave: (input: Parameters<typeof repository.restock>[0]) => Promise<unknown> }) {
  const tobacco = product.categoryKind === "tobacco";
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const quantity = tobacco ? (optionalDecimalFromInput(form.get("packs")) ?? 0) * 1000 : numberFromInput(form.get("packs")); const supplierId = String(form.get("supplierId") ?? "").trim() || undefined; void onSave({ productId: product.id, cartons: tobacco ? 0 : numberFromInput(form.get("cartons")), packs: Math.round(quantity), supplierId, totalCostCents: centsFromInput(form.get("cost")), note: String(form.get("note") ?? ""), occurredAt: String(form.get("date")) }); };
  const localInputDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const activeSuppliers = suppliers.filter((supplier) => !supplier.deletedAt).sort((a, b) => a.name.localeCompare(b.name));
  return <Sheet title={`补货 · ${product.name}`} onClose={onClose}><form className="form-stack" onSubmit={submit}>{tobacco ? <Field label="进货（公斤）"><input name="packs" type="number" inputMode="decimal" min="0" step="0.001" defaultValue="" /></Field> : productHasBundle(product) ? <div className="form-grid"><Field label={`进货（${productBundleUnitLabel(product)}）`}><input name="cartons" type="number" inputMode="numeric" min="0" defaultValue="0" /></Field><Field label={`另外（${productBaseUnitLabel(product)}）`}><input name="packs" type="number" inputMode="numeric" min="0" defaultValue="0" /></Field></div> : <Field label={`进货（${productBaseUnitLabel(product)}）`}><input name="packs" type="number" inputMode="numeric" min="0" defaultValue="0" /></Field>}<Field label="供应商"><select name="supplierId" defaultValue=""><option value="">不选择供应商</option>{activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></Field><Field label="本次进货总成本"><MoneyInput name="cost" /></Field><Field label="备注"><input name="note" autoComplete="off" /></Field><Field label="日期"><input name="date" type="datetime-local" required defaultValue={localInputDate} /></Field><button className="primary-button">确认入库</button></form></Sheet>;
}

function RestockHistorySheet({ data, currency, onClose }: { data: AppSnapshot; currency: string; onClose: () => void }) {
  const products = new Map(data.products.map((product) => [product.id, product]));
  const suppliers = new Map(data.suppliers.map((supplier) => [supplier.id, supplier.name]));
  const records = data.inventoryMovements.filter((movement) => movement.reason === "restock" && !movement.deletedAt).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const totalCost = records.reduce((sum, movement) => sum + (movement.totalCostCents ?? 0), 0);
  const quantityLabel = (movement: InventoryMovement, product?: Product) => {
    if (!product) return `${movement.quantityDeltaPacks} 件`;
    if (product.categoryKind === "tobacco") return `${(movement.quantityDeltaPacks / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 })} 公斤`;
    if (productHasBundle(product)) {
      const cartons = Math.floor(movement.quantityDeltaPacks / product.packsPerCarton);
      const packs = movement.quantityDeltaPacks % product.packsPerCarton;
      return [cartons ? `${cartons}${productBundleUnitLabel(product)}` : "", packs ? `${packs}${productBaseUnitLabel(product)}` : ""].filter(Boolean).join(" + ") || `0${productBaseUnitLabel(product)}`;
    }
    return `${movement.quantityDeltaPacks}${productBaseUnitLabel(product)}`;
  };
  return <Sheet title="补货记录" onClose={onClose}><div className="restock-history-summary"><span>共 {records.length} 笔补货</span><strong>货值合计 {formatMoney(totalCost, currency)}</strong></div><div className="restock-history-list">{records.length ? records.map((movement) => { const product = products.get(movement.productId); const supplierName = movement.supplierNameSnapshot ?? (movement.supplierId ? suppliers.get(movement.supplierId) : undefined) ?? "未选择供应商"; return <div className="restock-history-row" key={movement.id}><div className="restock-history-main"><strong>{product?.name ?? "已删除商品"}</strong><small>{new Date(movement.occurredAt).toLocaleString("zh-CN")} · 供应商：{supplierName}</small>{movement.note && <small>{movement.note}</small>}</div><div className="restock-history-values"><b>{quantityLabel(movement, product)}</b><span>{movement.totalCostCents === undefined ? "货值 —" : `货值 ${formatMoney(movement.totalCostCents, currency)}`}</span></div></div>; }) : <p className="empty-inline">还没有补货记录。</p>}</div></Sheet>;
}

function CountSheet({ product, currentStock, onClose, onSave }: { product: Product; currentStock: number; onClose: () => void; onSave: (actualStockPacks: number, note: string) => Promise<unknown> }) {
  const tobacco = product.categoryKind === "tobacco";
  const hasBundle = productHasBundle(product);
  const currentCartons = hasBundle ? Math.floor(Math.max(0, currentStock) / product.packsPerCarton) : 0;
  const currentPacks = hasBundle ? Math.max(0, currentStock) % product.packsPerCarton : Math.max(0, currentStock);
  const [actualCartons, setActualCartons] = useState(String(currentCartons));
  const [actualPacks, setActualPacks] = useState(tobacco ? String(Math.max(0, currentStock) / 1000) : String(currentPacks));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const actualStockPacks = useMemo(() => {
    const parseNumber = (value: string) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0, number) : 0;
    };
    if (tobacco) return Math.round(parseNumber(actualPacks) * 1000);
    if (hasBundle) return Math.round(parseNumber(actualCartons)) * product.packsPerCarton + Math.round(parseNumber(actualPacks));
    return Math.round(parseNumber(actualPacks));
  }, [actualCartons, actualPacks, hasBundle, product.packsPerCarton, tobacco]);
  const difference = actualStockPacks - currentStock;
  const differenceText = difference === 0
    ? "无差异"
    : `${difference > 0 ? "+" : "-"}${formatProductStock(Math.abs(difference), product).replace(/^(余|差)\s*/, "")}`;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await onSave(actualStockPacks, note);
    } finally {
      setSaving(false);
    }
  };
  return <Sheet title={`盘点 · ${product.name}`} onClose={onClose}>
    <div className="stocktake-current"><span>系统当前库存</span><strong>{formatProductStock(currentStock, product)}</strong></div>
    <form className="form-stack" onSubmit={submit}>
      {tobacco ? <Field label="实际库存（公斤）"><input name="actualPacks" type="number" inputMode="decimal" min="0" step="0.001" required value={actualPacks} onChange={(event) => setActualPacks(event.target.value)} /></Field> : hasBundle ? <div className="form-grid"><Field label={`实际库存（${productBundleUnitLabel(product)}）`}><input name="actualCartons" type="number" inputMode="numeric" min="0" required value={actualCartons} onChange={(event) => setActualCartons(event.target.value)} /></Field><Field label={`另外（${productBaseUnitLabel(product)}）`}><input name="actualPacks" type="number" inputMode="numeric" min="0" required value={actualPacks} onChange={(event) => setActualPacks(event.target.value)} /></Field></div> : <Field label={`实际库存（${productBaseUnitLabel(product)}）`}><input name="actualPacks" type="number" inputMode="numeric" min="0" required value={actualPacks} onChange={(event) => setActualPacks(event.target.value)} /> </Field>}
      <div className="stocktake-preview" aria-live="polite"><div><span>盘点后库存</span><strong>{formatProductStock(actualStockPacks, product)}</strong></div><div><span>需要修正</span><strong className={difference < 0 ? "danger-text" : difference > 0 ? "warning-text" : "same-text"}>{differenceText}</strong></div></div>
      <p className="stocktake-help">确认后只记录本次差额，已有的进货和销售流水不会被删除。</p>
      <Field label="盘点原因（可不填）"><input name="note" autoComplete="off" placeholder="例如：损坏、遗失、漏记销售" value={note} onChange={(event) => setNote(event.target.value)} /></Field>
      <button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "确认并修正库存"}</button>
    </form>
  </Sheet>;
}

function MovementSheet({ product, products, movements, suppliers, onClose, onAdjust }: { product: Product; products: Product[]; movements: InventoryMovement[]; suppliers: AppSnapshot["suppliers"]; onClose: () => void; onAdjust: (delta: number, note: string) => Promise<unknown> }) {
  const labels: Record<InventoryMovement["reason"], string> = { opening: "期初库存", restock: "进货", sale: "销售", manualAdjustment: "人工调整", stocktake: "库存盘点", saleVoid: "交易作废" };
  const tobacco = product.categoryKind === "tobacco";
  const tobaccoProductIds = new Set(products.filter((entry) => entry.categoryKind === "tobacco").map((entry) => entry.id));
  const productMovements = movements.filter((movement) => tobacco ? tobaccoProductIds.has(movement.productId) : movement.productId === product.id);
  const supplierNames = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const input = Number(form.get("delta") || 0); const delta = tobacco ? Math.round(input * 1000) : Math.round(input); const note = String(form.get("note") ?? ""); void onAdjust(delta, note).then(() => formElement.reset()); };
  return <Sheet title={`${product.name} · 库存流水`} onClose={onClose}><div className="movement-list">{productMovements.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).map((movement) => { const supplierName = movement.supplierNameSnapshot ?? (movement.supplierId ? supplierNames.get(movement.supplierId) : undefined); return <div key={movement.id}><span><strong>{labels[movement.reason]}</strong><small>{new Date(movement.occurredAt).toLocaleString("zh-CN")}{supplierName ? ` · 供应商：${supplierName}` : ""}{movement.note ? ` · ${movement.note}` : ""}</small></span><b className={movement.quantityDeltaPacks < 0 ? "danger-text" : ""}>{movement.quantityDeltaPacks > 0 ? "+" : ""}{tobacco ? `${(movement.quantityDeltaPacks / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 })} 公斤` : `${movement.quantityDeltaPacks} ${productBaseUnitLabel(product)}`}</b></div>; })}</div><form className="adjustment-form" onSubmit={submit}><h3>人工调整</h3><p>增加请输入正数，减少请输入负数。所有调整都会保留流水。</p><div className="form-grid"><Field label={tobacco ? "变动公斤数" : `变动${productBaseUnitLabel(product)}数`}><input name="delta" type="number" inputMode={tobacco ? "decimal" : "numeric"} required step={tobacco ? "0.001" : "1"} placeholder={tobacco ? "例如 -0.5" : "例如 -2"} /></Field><Field label="原因"><input name="note" required autoComplete="off" /></Field></div><button className="secondary-button">记录调整</button></form></Sheet>;
}

function SaleSheet({ sale, items, currency, onClose, onVoid, onEditPrice }: { sale: Sale; items: SaleItem[]; currency: string; onClose: () => void; onVoid: () => Promise<unknown>; onEditPrice: (itemId: string, priceCents: number) => Promise<boolean> }) {
  const [editingItemId, setEditingItemId] = useState<string>();
  const [draftPrice, setDraftPrice] = useState("");
  const [priceError, setPriceError] = useState("");
  const startEditing = (item: SaleItem) => {
    setEditingItemId(item.id);
    setDraftPrice((item.unitSalePriceCents / 100).toFixed(2));
    setPriceError("");
  };
  const savePrice = async (item: SaleItem) => {
    const value = Number(draftPrice);
    if (!Number.isFinite(value) || value < 0) {
      setPriceError("请输入有效的成交价");
      return;
    }
    const ok = await onEditPrice(item.id, Math.round(value * 100));
    if (ok) {
      setEditingItemId(undefined);
      setPriceError("");
    }
  };
  return <Sheet title="交易详情" onClose={onClose}><div className="sale-detail"><p className="detail-date">{new Date(sale.completedAt).toLocaleString("zh-CN")}</p><p className="detail-device">销售：{sale.deviceLabelSnapshot ?? "本机"}</p>{items.map((item) => {
    const unitLabel = item.unitLabelSnapshot ?? (item.unitType === "carton" ? "条" : "包");
    const editing = editingItemId === item.id;
    return <div className="detail-line" key={item.id}><div className="detail-line-info"><strong>{item.productNameSnapshot}</strong>{editing ? <div className="detail-price-editor"><div className="money-input"><span>$</span><input autoFocus aria-label="已完成交易成交价" type="number" inputMode="decimal" min="0" step="0.01" value={draftPrice} onChange={(event) => setDraftPrice(event.target.value)} /></div><button className="detail-price-save" type="button" onClick={() => void savePrice(item)}>保存</button><button className="detail-price-cancel" type="button" onClick={() => setEditingItemId(undefined)}>取消</button></div> : <span>{item.quantity} {unitLabel} × {formatMoney(item.unitSalePriceCents, currency)} {!sale.voidedAt && <button className="detail-price-button" type="button" onClick={() => startEditing(item)}>改价</button>}</span>}{editing && priceError && <small className="detail-price-error">{priceError}</small>}</div><b>{formatMoney(item.lineRevenueCents, currency)}</b></div>;
  })}<div className="detail-totals"><span>收入<b>{formatMoney(sale.revenueCents, currency)}</b></span><span>成本<b>{formatMoney(sale.costCents, currency)}</b></span><span>毛利<b>{formatMoney(sale.profitCents, currency)}</b></span></div>{sale.voidedAt ? <p className="void-note">这笔交易已作废。</p> : <button className="text-danger" onClick={() => window.confirm("确定作废这笔交易并恢复库存吗？") && void onVoid()}>作废交易</button>}</div></Sheet>;
}

function CartTotalSheet({ totalCents, itemCount, currency, onClose, onSave }: { totalCents: number; itemCount: number; currency: string; onClose: () => void; onSave: (totalCents: number) => Promise<unknown> }) {
  const [draft, setDraft] = useState((totalCents / 100).toFixed(2));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSave(centsFromInput(draft));
  };
  return <Sheet title="修改本单金额" onClose={onClose}><form className="cart-total-editor" onSubmit={submit}><p className="cart-total-editor-note">本单共 {itemCount} 件，直接输入这一单最终收款总额。商品数量和库存不变。</p><label className="cart-total-editor-field"><span>本单总金额</span><div className="money-input"><span>{currency}</span><input ref={inputRef} autoFocus type="number" inputMode="decimal" min="0" step="0.01" required value={draft} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)} /></div></label><button className="primary-button" type="submit">保存本单金额</button></form></Sheet>;
}

function CartSheet({ data, currency, onClose, onMutate }: { data: AppSnapshot; currency: string; onClose: () => void; onMutate: (action: () => Promise<unknown>, message?: string) => Promise<boolean> }) {
  const totals = calculateCart(data);
  const [editingItem, setEditingItem] = useState<{ productId: string; unitType: UnitType } | null>(null);
  const [draftPrice, setDraftPrice] = useState("");
  const startEditing = (item: CartItem, defaultPrice: number) => {
    setEditingItem({ productId: item.productId, unitType: item.unitType });
    setDraftPrice(((item.unitPriceCents ?? defaultPrice) / 100).toFixed(2));
  };
  const savePrice = async (item: CartItem) => {
    const cents = centsFromInput(draftPrice);
    const ok = await onMutate(() => repository.setCartItemPrice(item.productId, item.unitType, cents), "本单价格已调整");
    if (ok) setEditingItem(null);
  };
  return <Sheet title="本单明细" onClose={onClose}><div className="cart-lines">{data.cart.items.map((item) => { const product = data.products.find((entry) => entry.id === item.productId); if (!product) return null; const defaultPrice = item.unitType === "carton" ? product.cartonSalePriceCents : product.packSalePriceCents; const price = item.unitPriceCents ?? defaultPrice; const isEditing = editingItem?.productId === item.productId && editingItem.unitType === item.unitType; return <div className="cart-line" key={`${item.productId}:${item.unitType}`}><div className="cart-line-info"><strong>{product.name}</strong>{isEditing ? <div className="cart-price-editor"><div className="money-input"><span>$</span><input autoFocus aria-label="本单成交价" type="number" inputMode="decimal" min="0" step="0.01" value={draftPrice} onChange={(event) => setDraftPrice(event.target.value)} /></div><button className="cart-price-save" type="button" onClick={() => void savePrice(item)}>确定</button></div> : <span>{productUnitLabel(product, item.unitType)} · {formatMoney(price, currency)} <button className="cart-price-button" type="button" onClick={() => startEditing(item, defaultPrice)}>改价</button></span>}</div><div className="stepper" aria-label={`${product.name}${productUnitLabel(product, item.unitType)}数量`}><button type="button" aria-label={`减少一个${productUnitLabel(product, item.unitType)}`} onClick={() => { triggerTapHaptic(); void onMutate(() => repository.updateCartQuantity(item.productId, item.unitType, item.quantity - 1)); }}>−</button><b aria-live="polite">{item.quantity}</b><button type="button" aria-label={`增加一个${productUnitLabel(product, item.unitType)}`} onClick={() => { triggerTapHaptic(); void onMutate(() => repository.updateCartQuantity(item.productId, item.unitType, item.quantity + 1)); }}>+</button></div></div>; })}<div className="cart-total"><span>{totals.itemCount} 件</span><strong>{formatMoney(totals.revenueCents, currency)}</strong></div><button className="primary-button" onClick={() => void onMutate(() => repository.completeSale(), "本单已完成").then((ok) => ok && onClose())}>完成本单</button><button className="text-danger" onClick={() => window.confirm("清空当前本单吗？") && void onMutate(() => repository.clearCart()).then((ok) => ok && onClose())}>清空本单</button></div></Sheet>;
}

function BackupReminderSheet({ onClose, onExport, onNotice }: { onClose: () => void; onExport: () => Promise<void>; onNotice: (message: string, kind?: Notice["kind"]) => void }) {
  const [busy, setBusy] = useState(false);
  const exportNow = async () => {
    setBusy(true);
    try {
      await onExport();
      onNotice("备份文件已导出，请在“文件”App 的“下载”中查看");
      onClose();
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "备份导出失败", "error");
    } finally {
      setBusy(false);
    }
  };
  return <Sheet title="每周备份提醒" onClose={onClose}><div className="backup-reminder"><div className="backup-reminder-icon">✓</div><h3>请备份本周的销售数据</h3><p>建议把备份文件保存到 iPhone 的“文件”App。自动备份已经保存在本机，也可以稍后再导出。</p><button className="primary-button" disabled={busy} onClick={() => void exportNow()}>导出到文件</button><button className="text-danger" disabled={busy} onClick={onClose}>稍后处理</button></div></Sheet>;
}

function SettingsSheet({ data, sync, onClose, onNotice }: { data: AppSnapshot; sync: SyncViewState; onClose: () => void; onNotice: (message: string, kind?: Notice["kind"]) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [localBackups, setLocalBackups] = useState<LocalBackupRecord[]>([]);
  const [backupBusy, setBackupBusy] = useState(false);
  const [reminderSettings, setReminderSettings] = useState<BackupReminderSettings>(DEFAULT_BACKUP_REMINDER_SETTINGS);
  const refreshLocalBackups = useCallback(async () => {
    setLocalBackups(await repository.listLocalBackups());
  }, []);
  useEffect(() => {
    void refreshLocalBackups();
    const unsubscribe = repository.subscribe(() => void refreshLocalBackups());
    return () => {
      unsubscribe();
    };
  }, [refreshLocalBackups]);
  useEffect(() => {
    void loadBackupReminderSettings().then(setReminderSettings);
  }, []);
  const updateReminderSettings = async (patch: Partial<BackupReminderSettings>) => {
    const next = { ...reminderSettings, ...patch };
    setReminderSettings(next);
    await saveBackupReminderSettings(next);
    onNotice("备份提醒设置已保存");
  };
  const createManualBackup = async () => {
    setBackupBusy(true);
    try {
      await repository.createLocalBackup("manual", localDateKey(new Date()), "手动备份");
      await refreshLocalBackups();
      onNotice("本机备份已保存");
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "自动备份失败", "error");
    } finally {
      setBackupBusy(false);
    }
  };
  const exportManualBackup = async () => {
    setBackupBusy(true);
    try {
      await downloadBackupFile("project-one-manual-backup");
      onNotice("备份文件已导出，请在“文件”App 的“下载”中查看");
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "备份导出失败", "error");
    } finally {
      setBackupBusy(false);
    }
  };
  const resetBusinessData = async () => {
    if (!window.confirm("确定要重置吗？请先备份。重置后本机业务数据会被清空。")) return;
    setBackupBusy(true);
    try {
      await repository.resetBusinessData();
      syncService.stop();
      onNotice("本机业务数据已重置");
      window.setTimeout(() => location.reload(), 500);
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "数据重置失败", "error");
    } finally {
      setBackupBusy(false);
    }
  };
  const restoreLocalBackup = async (record: LocalBackupRecord) => {
    if (!window.confirm(`确定恢复 ${new Date(record.createdAt).toLocaleString("zh-CN")} 的备份吗？当前数据会先自动保护。`)) return;
    setBackupBusy(true);
    try {
      await repository.restoreLocalBackup(record.id);
      await syncService.notifyLocalChange();
      await refreshLocalBackups();
      onNotice("本地备份已恢复");
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "恢复备份失败", "error");
    } finally {
      setBackupBusy(false);
    }
  };
  const shareInvite = async () => { const url = createInviteUrl(data.pairing.secret); try { if (navigator.share) await navigator.share({ title: "Project One", text: "在第二台设备上打开此私密邀请。", url }); else { await navigator.clipboard.writeText(url); onNotice("邀请链接已复制"); } } catch (reason) { if ((reason as DOMException)?.name !== "AbortError") onNotice("无法分享邀请链接", "error"); } };
  const importFile = async (file?: File) => { if (!file) return; try { await downloadBackupFile("project-one-before-import"); const backup = JSON.parse(await file.text()) as BackupDocument; await repository.importBackup(backup); await syncService.notifyLocalChange(); onNotice("备份已导入，导入前快照已下载"); } catch (reason) { onNotice(reason instanceof Error ? reason.message : "导入失败", "error"); } finally { if (fileRef.current) fileRef.current.value = ""; } };
  const statusText = sync.status === "connected" ? "已连接" : sync.status === "syncing" ? "同步中" : sync.status === "offline" ? "离线" : data.pendingCount ? "待同步" : "本机";
  const backupKindLabel = (record: LocalBackupRecord) => record.kind === "daily" ? "每日自动备份" : record.kind === "manual" ? "手动备份" : "恢复前保护备份";
  const latestBackup = localBackups[0];
  return <Sheet title="设置" onClose={onClose}><div className="settings-list"><section><h3>设备连接</h3><div className="setting-row"><span><strong>{statusText}</strong><small>{data.pendingCount ? `${data.pendingCount} 项等待同步` : sync.lastSyncedAt ? `最后同步 ${formatTime(sync.lastSyncedAt)}` : "本机数据已安全保存"}</small></span><span className={`connection-dot ${sync.status}`} /></div><button className="setting-button" onClick={() => void shareInvite()}>邀请第二台设备</button><p className="privacy-note">邀请包含私密连接信息，请只通过可信方式发送。打开后会从地址栏自动移除。</p></section><section><h3>备份</h3><div className="setting-row"><span><strong>每天晚上 8 点后自动备份</strong><small>{latestBackup ? `最近：${new Date(latestBackup.createdAt).toLocaleString("zh-CN")} · 共 ${localBackups.length} 份` : "应用会在 20:00 后首次打开时补做备份"}</small></span><span className="backup-status-dot" /></div><button className="setting-button" disabled={backupBusy} onClick={() => void createManualBackup()}>立即保存一份本机备份</button><button className="setting-button" onClick={() => void downloadBackupFile()}>导出备份到文件</button><button className="setting-button" onClick={() => fileRef.current?.click()}>从文件导入备份</button><input ref={fileRef} className="hidden-input" type="file" accept="application/json,.json" onChange={(event) => void importFile(event.target.files?.[0])} /><div className="backup-history">{localBackups.length ? localBackups.map((record) => <div className="backup-history-row" key={record.id}><span><strong>{backupKindLabel(record)}</strong><small>{new Date(record.createdAt).toLocaleString("zh-CN")}</small></span><button type="button" disabled={backupBusy} onClick={() => void restoreLocalBackup(record)}>恢复</button></div>) : <p className="backup-empty">还没有自动备份。每天 20:00 后打开应用就会生成第一份。</p>}</div><p className="privacy-note">自动备份保存在本机浏览器存储，不会上传网络；清除 Safari 网站数据或卸载应用后，本机备份也会消失，重要时请导出到“文件”。</p></section><section><h3>备份提醒</h3><label className="reminder-control"><span><strong>提醒频率</strong><small>默认每周一次，在下次打开应用时提醒</small></span><select value={reminderSettings.frequency} onChange={(event) => void updateReminderSettings({ frequency: event.target.value as BackupReminderSettings["frequency"] })}><option value="weekly">每周一次</option><option value="daily">每天一次</option><option value="off">关闭提醒</option></select></label>{reminderSettings.frequency === "weekly" && <label className="reminder-control"><span><strong>提醒星期</strong><small>默认周日下午</small></span><select value={reminderSettings.weekday} onChange={(event) => void updateReminderSettings({ weekday: Number(event.target.value) })}>{backupReminderWeekdays.map((weekday, index) => <option value={index} key={weekday}>{weekday}</option>)}</select></label>}<label className="reminder-control"><span><strong>提醒时间</strong><small>默认 12:00 以后</small></span><input type="time" value={reminderSettings.time} onChange={(event) => void updateReminderSettings({ time: event.target.value })} /></label><p className="privacy-note">这是应用内提醒，不是 iPhone 锁屏通知；如果应用关闭，会在设定时间之后下一次打开时显示一次。</p></section><section><h3>本机信息</h3><DeviceNameInput value={data.device.label} onSave={(label) => void repository.updateDeviceLabel(label)} /><div className="setting-row"><span><strong>设备 ID</strong><small>{data.device.deviceId.slice(0, 8)}</small></span></div><p className="privacy-note">每笔销售会保留本机名称，用来标记是谁在这台设备上记账。</p>{data.conflictCount > 0 && <p className="privacy-note">已自动处理 {data.conflictCount} 次同时修改冲突。</p>}</section><section className="danger-section"><h3>数据操作</h3><div className="data-action-buttons"><button className="setting-button" disabled={backupBusy} onClick={() => void exportManualBackup()}>备份</button><button className="setting-button danger" disabled={backupBusy} onClick={() => void resetBusinessData()}>数据重置</button></div><p className="privacy-note">重置前请先点击“备份”，确认后本机业务数据会被清空。</p></section></div></Sheet>;
}

function DeviceNameInput({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => {
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
  }, []);
  const commit = () => {
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    if (!next) setDraft(value);
  };
  const change = (next: string) => {
    setDraft(next);
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    const normalized = next.trim();
    if (!normalized || normalized === value) return;
    saveTimer.current = window.setTimeout(() => {
      onSave(normalized);
      saveTimer.current = undefined;
    }, 300);
  };
  return <label className="device-name-field"><span><strong>本机名称</strong><small>销售记录会保留这个名称，输入后自动保存</small></span><input value={draft} placeholder="例如：前台、老板、Alex" maxLength={40} onChange={(event) => change(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") { event.currentTarget.blur(); } }} /></label>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function MoneyInput({ name, cents, required = true }: { name: string; cents?: number; required?: boolean }) { return <div className="money-input"><span>$</span><input name={name} type="number" inputMode="decimal" min="0" step="0.01" required={required} placeholder="0.00" defaultValue={cents === undefined ? "" : (cents / 100).toFixed(2)} /></div>; }

function calculateCart(data: AppSnapshot) {
  const totals = data.cart.items.reduce((total, item: CartItem) => { const product = data.products.find((entry) => entry.id === item.productId); if (!product) return total; const defaultPrice = item.unitType === "carton" ? product.cartonSalePriceCents : product.packSalePriceCents; const price = item.unitPriceCents ?? defaultPrice; return { itemCount: total.itemCount + item.quantity, revenueCents: total.revenueCents + price * item.quantity }; }, { itemCount: 0, revenueCents: 0 });
  return { ...totals, revenueCents: data.cart.totalOverrideCents ?? totals.revenueCents };
}

function analysisRange(period: AnalysisPeriod, customStart: string, customEnd: string) {
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (period === "7d") start.setDate(start.getDate() - 6);
  if (period === "30d") start.setDate(start.getDate() - 29);
  if (period === "month") start.setDate(1);
  if (period === "custom") { const customStartDate = new Date(`${customStart}T00:00:00`); const customEndDate = new Date(`${customEnd}T23:59:59.999`); return { start: customStartDate, end: customEndDate }; }
  return { start, end };
}
