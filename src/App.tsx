import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleHelp, Copy, FileImage, FolderClosed, Grid2X2, List, LoaderCircle, LockKeyhole, LogOut, Package, Plus, Search, ShieldCheck, Sparkles, Upload, Wallet, X } from 'lucide-react';
import { draftSchema, type Currency, type DraftInput, type Handoff, type Session } from '@handoff/contracts';
import { en } from './en';
import { api, connect, filterHandoffs, formatBytes, formatDate, shortAddress } from './lib';
import { samples } from './samples';

const statuses = { draft: en.draft, 'awaiting-client': en.awaiting, ready: en.ready };
const messageOf = (error: unknown) => error instanceof Error ? error.message : en.networkError;

function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} onCancel={close} onClick={event => { if (event.target === ref.current) close(); }}><div className="modal-content"><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label={en.close} onClick={close}><X size={20} /></button></div>{children}</div></dialog>;
}

function Artwork({ kind, compact = false }: { kind: string; compact?: boolean }) {
  return <div className={`artwork art-${kind} ${compact ? 'compact' : ''}`} aria-hidden="true">
    {kind === 'olive' ? <><span className="art-corner">A MORE INTENTIONAL EVERYDAY</span><div className="olive-word">olive<span>STUDIO</span></div><div className="olive-leaf leaf-one" /><div className="olive-leaf leaf-two" /><span className="art-foot">BRAND IDENTITY · 2026</span></> : kind === 'form' ? <><span className="art-corner">FORM & FIELD®</span><div className="form-word">Good<br />things<br /><i>take form.</i></div><div className="form-ball" /><span className="art-foot">A FRESH PERSPECTIVE.</span></> : <><span className="art-corner">SLOW MORNINGS. GOOD COFFEE.</span><div className="coffee-bag"><span>kinfolk<span className="coffee-star">✳</span></span><small>GOOD COMPANY.<br />GREAT COFFEE.</small></div><span className="art-foot">PACKAGING EXPLORATION · VOL. 01</span></>}
    <div className="sample-watermark">HANDOFF PREVIEW</div>
  </div>;
}

function WalletModal({ close, connected }: { close: () => void; connected: (user: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function signIn(currency: Currency) {
    setBusy(true); setError('');
    try { connected(await connect(currency)); close(); } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <Modal title={en.connectTitle} close={close}><p className="muted">{en.connectBody}</p><div className="wallet-options"><button disabled={busy} onClick={() => void signIn('NIM')}><span className="coin nim">N</span>{en.connectNim}<ArrowRight size={18}/></button><button disabled={busy} onClick={() => void signIn('USDT')}><span className="coin usdt">₮</span>{en.connectUsdt}<ArrowRight size={18}/></button></div>{busy && <p role="status" className="inline-status"><LoaderCircle className="spin" size={16}/>{en.connecting}</p>}{error && <p role="alert" className="error">{error}</p>}</Modal>;
}

function DraftModal({ user, handoff, close, saved, signIn }: { user: Session | null; handoff?: Handoff; close: () => void; saved: (h: Handoff) => void; signIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) { signIn(); return; }
    const form = new FormData(event.currentTarget);
    const raw = Object.fromEntries(form.entries());
    let data: DraftInput;
    try { data = draftSchema.parse({ ...raw, currency: handoff?.currency ?? user.currency, deadline: new Date(String(raw.deadline) + 'T23:59:00').toISOString() }); }
    catch { setError(en.required); return; }
    setBusy(true); setError('');
    try {
      const result = await api<{ handoff: Handoff }>(handoff ? `/handoffs/${handoff.id}` : '/handoffs', { method: handoff ? 'PUT' : 'POST', body: JSON.stringify(data) });
      saved(result.handoff); close();
    } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <Modal title={handoff ? en.editTitle : en.newTitle} close={close}><p className="muted">{en.newSubtitle}</p><form onSubmit={event => void submit(event)} className="draft-form">
    <label>{en.titleLabel}<input name="title" autoFocus required maxLength={100} defaultValue={handoff?.title} placeholder={en.titlePlaceholder}/></label>
    <label>{en.descriptionLabel}<textarea name="description" rows={2} maxLength={2000} defaultValue={handoff?.description} placeholder={en.descriptionPlaceholder}/></label>
    <label>{en.clientLabel}<input name="clientLabel" required maxLength={100} defaultValue={handoff?.clientLabel} placeholder={en.clientPlaceholder}/></label>
    <div className="form-row"><label>{en.amount}<div className="amount-input"><input name="amount" required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" defaultValue={handoff?.amount} placeholder="0.00"/><span>{handoff?.currency ?? user?.currency ?? 'NIM'}</span></div></label><label>{en.deadline}<input type="date" name="deadline" required min={new Date().toLocaleDateString('en-CA')} max={new Date(Date.now() + 29 * 86400_000).toLocaleDateString('en-CA')} defaultValue={handoff?.deadline.slice(0, 10) ?? new Date(Date.now() + 7 * 86400_000).toLocaleDateString('en-CA')}/></label></div>
    <p className="field-note">{en.walletCurrency}</p>
    <label>{en.terms}<textarea name="terms" required rows={3} maxLength={2000} defaultValue={handoff?.terms ?? en.defaultTerms}/></label><p className="field-note">{en.termsHelp}</p>
    {error && <p className="error" role="alert">{error}</p>}<div className="modal-footer"><button type="button" className="button secondary" onClick={close}>{en.cancel}</button><button className="button primary" disabled={busy}>{busy ? en.saving : user ? en.saveDraft : en.signInToSave}<ArrowRight size={16}/></button></div>
  </form></Modal>;
}

function Delivery({ handoff, example, owner, user, update, edit, signIn, notify }: { handoff: Handoff; example: boolean; owner: boolean; user: Session | null; update: (h: Handoff) => void; edit: () => void; signIn: () => void; notify: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wallets, setWallets] = useState<string[]>([]);
  const [binding, setBinding] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (owner && handoff.status !== 'draft') void api<{ wallets: string[] }>(`/handoffs/${handoff.id}/requests`).then(data => setWallets(data.wallets)).catch(error => setError(messageOf(error)));
  }, [owner, handoff.id, handoff.status]);
  async function action(path: string, data?: unknown, method = 'POST') {
    setBusy(true); setError('');
    try {
      const result = await api<{ handoff: Handoff }>(`/handoffs/${handoff.id}/${path}`, { method, body: data === undefined ? undefined : JSON.stringify(data) });
      update(result.handoff); setBinding('');
    } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError('');
    try {
      for (const file of Array.from(files)) {
        const form = new FormData(); form.append('file', file);
        const result = await api<{ handoff: Handoff }>(`/handoffs/${handoff.id}/files`, { method: 'POST', body: form });
        update(result.handoff);
      }
    } catch (error) { setError(messageOf(error)); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function requestAccess() {
    if (!user) { signIn(); return; }
    setBusy(true); setError('');
    try { await api(`/public/${handoff.id}/request-access`, { method: 'POST' }); notify(en.requestSent); } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  async function share() {
    try { await navigator.clipboard.writeText(`${location.origin}/h/${handoff.id}`); notify(en.copied); } catch { setError(`${location.origin}/h/${handoff.id}`); }
  }
  const file = handoff.files[selected];
  return <>
    <div className="delivery-heading"><div><p className="eyebrow">{example ? en.sample : en.delivery}</p><h1>{handoff.title}</h1><p className="muted delivery-description">{handoff.description}</p></div>{owner && handoff.status === 'draft' && <button className="button secondary" onClick={edit}>{en.edit}</button>}</div>
    {example && <div className="notice"><Sparkles size={16}/>{en.sampleNotice}</div>}
    <div className="delivery-grid"><div className="delivery-main"><div className="preview-frame">
      {example ? <Artwork kind={handoff.id}/> : file ? <img src={`/api/previews/${handoff.id}/${file.id}`} alt={`${en.previewOnly}: ${file.name}`}/> : <div className="empty-preview"><FileImage size={38}/><h3>{en.noFiles}</h3><p>{en.noFilesBody}</p></div>}
      <div className="preview-caption"><span><ShieldCheck size={16}/>{en.previewOnly}</span><span>{en.protected}</span></div>
    </div><p className="field-note privacy-note"><LockKeyhole size={13}/>{en.privateNote}</p>
    <section className="panel file-panel"><div className="section-heading"><h3>{en.originalFiles}</h3><span className="muted">{handoff.files.length} {en.files}</span></div>
      {handoff.files.map((f, index) => <button key={f.id} className={`file-row ${index === selected ? 'selected' : ''}`} onClick={() => setSelected(index)}><span className="file-icon"><FileImage size={20}/></span><span className="file-info"><strong>{f.name}</strong><span>{formatBytes(f.bytes)}{owner && ` · ${f.scan === 'quarantined' ? en.scanBlocked : f.approved ? en.approved : en.needsApproval}`}</span></span><LockKeyhole size={16}/></button>)}
    </section><section className="panel terms-panel"><h3>{en.termsTitle}</h3><p>{handoff.terms}</p><div className="divider"/><p className="field-note">{en.deadline}: {formatDate(handoff.deadline)}</p><p className="field-note">{en.downloadWindow}</p></section></div>
    <aside className="delivery-aside"><section className="checkout-card"><span className="eyebrow">{en.amount}</span><p className="price">{new Intl.NumberFormat('en').format(Number(handoff.amount))} <span>{handoff.currency}</span></p><div className="network"><span className={`coin ${handoff.currency === 'NIM' ? 'nim' : 'usdt'}`}>{handoff.currency === 'NIM' ? 'N' : '₮'}</span>{handoff.currency === 'NIM' ? 'Nimiq' : 'Polygon'}</div><div className="divider"/><p className="field-note">{en.creator}</p><p className="wallet-address">{handoff.creator}</p><p className="field-note">{en.creatorLabelNote}</p><div className="payment-unavailable"><LockKeyhole size={18}/><strong>{en.paymentDisabled}</strong><p>{en.paymentDisabledBody}</p></div>{!owner && !example && <><p className="field-note">{en.approvalHint}</p><button className="button secondary full-width" disabled={busy} onClick={() => void requestAccess()}>{en.requestAccess}<ArrowRight size={16}/></button></>}</section>
    {owner && <section className="panel tools-panel"><h3>{en.creatorTools}</h3>{handoff.status === 'draft' ? <>
      <input ref={input} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={event => void upload(event.target.files)} aria-label={en.addFiles}/><button disabled={busy || handoff.files.length >= 10} className="button secondary full-width" onClick={() => input.current?.click()}><Upload size={16}/>{busy ? en.uploading : en.addFiles}</button><p className="field-note">{en.fileLimit}</p>
      {file && <><button disabled={busy} className="button secondary full-width" onClick={() => { void action(`files/${file.id}`, undefined, 'DELETE'); setSelected(0); }}>{en.removeFile}</button>{file.scan === 'quarantined' && <button disabled={busy} className="button secondary full-width" onClick={() => void action(`files/${file.id}/rescan`)}>{en.rescan}</button>}</>}
      <button className="button secondary full-width" disabled={busy || !handoff.files.length || handoff.files.some(f => f.scan !== 'clean')} onClick={() => void action('approve-previews', { fileIds: handoff.files.map(f => f.id) })}><CheckCheck size={16}/>{en.approve}</button>
      <button className="button primary full-width" disabled={busy || !handoff.files.length || handoff.files.some(f => !f.approved)} onClick={() => void action('publish')}>{en.publish}<ArrowUpRight size={16}/></button><p className="field-note">{en.publishHelp}</p>
    </> : <><button className="button primary full-width" onClick={() => void share()}><Copy size={16}/>{en.share}</button><h4>{en.invite}</h4><p className="field-note">{en.inviteHelp}</p>{handoff.clientWallet ? <><p className="field-note">{en.boundWallet}</p><p className="wallet-address">{handoff.clientWallet}</p></> : wallets.length ? wallets.map(wallet => <div className="wallet-request" key={wallet}><p className="wallet-address">{wallet}</p><button className="button secondary" onClick={() => setBinding(wallet)}>{en.approveWallet}</button></div>) : <p className="field-note">{en.noRequests}</p>}</> }</section>}
    <div className="support-note"><CircleHelp size={18}/><div><strong>{en.support}</strong><p>{en.supportBody}</p></div></div></aside></div>
    {error && <p role="alert" className="error">{error}</p>}
    {binding && <Modal title={en.bindTitle} close={() => setBinding('')}><p>{en.bindHelp}</p><p className="wallet-address">{binding}</p><button className="button primary" disabled={busy} onClick={() => void action('bind-client', { wallet: binding })}>{en.approveWallet}</button></Modal>}
  </>;
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [user, setUser] = useState<Session | null>(null);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [editing, setEditing] = useState<Handoff>();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [view, setView] = useState('grid');
  const [selected, setSelected] = useState<Handoff>();
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const requestVersion = useRef(0);
  function navigate(next: string) { history.pushState(null, '', next); setPath(next); setSelected(undefined); setError(''); window.scrollTo(0, 0); }
  useEffect(() => { const pop = () => { setPath(location.pathname); setSelected(undefined); setError(''); }; window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
  useEffect(() => { let active = true; void api<{ user: Session | null }>('/session').then(data => { if (active) setUser(data.user); }).catch(error => { if (active) setError(messageOf(error)); }).finally(() => { if (active) setLoaded(true); }); return () => { active = false; }; }, []);
  useEffect(() => {
    let active = true;
    if (user) void api<{ handoffs: Handoff[] }>('/handoffs').then(data => { if (active) setHandoffs(data.handoffs); }).catch(error => { if (active) setError(messageOf(error)); });
    else setHandoffs([]);
    return () => { active = false; };
  }, [user]);
  useEffect(() => {
    if (!loaded) return;
    const parts = path.split('/');
    if (parts[1] === 'example') { setSelected(samples.find(h => h.id === parts[2])); return; }
    if (!['h', 'draft'].includes(parts[1]) || !parts[2]) return;
    const version = ++requestVersion.current;
    void api<{ handoff: Handoff }>(parts[1] === 'draft' ? `/handoffs/${parts[2]}` : `/public/${parts[2]}`).then(async data => {
      const result = parts[1] === 'h' && user?.address === data.handoff.creator ? await api<{ handoff: Handoff }>(`/handoffs/${parts[2]}`) : data;
      if (requestVersion.current === version) setSelected(result.handoff);
    }).catch(error => { if (requestVersion.current === version) setError(messageOf(error)); });
    return () => { requestVersion.current++; };
  }, [path, loaded, user]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 5000); return () => window.clearTimeout(timer); }, [toast]);
  function update(handoff: Handoff) { setSelected(handoff); setHandoffs(items => items.some(h => h.id === handoff.id) ? items.map(h => h.id === handoff.id ? handoff : h) : [handoff, ...items]); }
  function newDraft() { setEditing(undefined); setDraftOpen(true); }
  async function logout() { try { await api('/logout', { method: 'POST' }); setUser(null); navigate('/'); } catch (error) { setError(messageOf(error)); } }
  const isExample = !user;
  const items = isExample ? samples : handoffs;
  const filtered = filterHandoffs(items, filter, search, sort);
  const detail = /^\/(h|draft|example)\//.test(path);
  const page = detail ? en.preview : path === '/purchases' ? en.purchases : path === '/how-it-works' ? en.howItWorks : en.handoffs;
  return <div className="app-shell"><a className="skip-link" href="#main">{en.skip}</a><aside className="sidebar"><button className="brand" onClick={() => navigate('/')} aria-label={en.brand}><span className="brand-mark"><ArrowUpRight size={23}/><ArrowDownLeft size={23}/></span>{en.brand}<span className="brand-dot">®</span></button><div className="workspace-label">{en.workspace}</div><nav aria-label={en.workspace}><button className={page === en.handoffs || detail ? 'nav-item active' : 'nav-item'} onClick={() => navigate('/')}><FolderClosed size={19}/>{en.handoffs}<span className="nav-count">{items.length}</span></button><button className={path === '/purchases' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('/purchases')}><Package size={19}/>{en.purchases}</button></nav><div className="sidebar-bottom"><div className="sidebar-note"><div className="little-spark">✳</div><p>{en.tagline}</p></div><button className="nav-item help-link" onClick={() => navigate('/how-it-works')}><CircleHelp size={18}/>{en.howItWorks}<ArrowUpRight size={15}/></button><div className="nimiq-credit"><span className="nimiq-dot"/>{en.builtFor}</div></div></aside>
  <div className="main-shell"><header className="topbar"><div className="breadcrumb"><span>{en.workspace}</span><span>/</span><strong>{page}</strong></div><div className="header-actions"><span className="pilot-pill"><span/>{en.pilot}</span>{user ? <><span className="connected-address"><span className="connection-dot"/>{shortAddress(user.address)}</span><button className="icon-button" onClick={() => void logout()} aria-label={en.signOut}><LogOut size={18}/></button></> : <button className="button wallet-button" onClick={() => setWalletOpen(true)}><Wallet size={16}/>{en.wallet}</button>}</div></header>
  <main id="main"><div className="main-inner">
    {detail ? <><button className="back-link" onClick={() => navigate('/')}><ArrowLeft size={16}/>{en.back}</button>{selected ? <Delivery key={selected.id} handoff={selected} example={path.startsWith('/example/')} owner={Boolean(user && user.address === selected.creator)} user={user} update={update} edit={() => { setEditing(selected); setDraftOpen(true); }} signIn={() => setWalletOpen(true)} notify={setToast}/> : !error && <p className="loading" role="status"><LoaderCircle className="spin"/>{en.loading}</p>}</> : path === '/purchases' ? <><div className="page-heading"><p className="eyebrow">{en.purchases}</p><h1>{en.purchasesTitle}</h1><p className="muted">{en.purchasesBody}</p></div><div className="empty-state"><span className="empty-icon"><Package size={30}/></span><h2>{en.purchasesEmpty}</h2><p>{en.purchasesHelp}</p></div></> : path === '/how-it-works' ? <><div className="page-heading"><p className="eyebrow">{en.howItWorks}</p><h1>{en.howTitle}</h1></div><div className="how-grid">{en.howSteps.map(([title, body], i) => <section className="panel" key={title}><span className="step-number">0{i + 1}</span><h2>{title}</h2><p>{body}</p></section>)}</div><p className="notice">{en.howNote}</p></> : <>
    <section className="hero"><div className="hero-copy"><p className="eyebrow"><span className="tiny-star">✳</span>{en.welcome}</p><h1>{en.heroTitle.split('\n').map(line => <span key={line}>{line}</span>)}</h1><p>{en.heroBody}</p><div className="hero-actions"><button className="button lime" onClick={newDraft}><Plus size={18}/>{en.newHandoff}</button><button className="hero-text-button" onClick={() => navigate('/example/olive')}>{en.viewExample}<ArrowUpRight size={16}/></button></div><div className="hero-footnote"><ShieldCheck size={14}/>{en.heroNote}</div></div><div className="hero-visual" aria-hidden="true"><div className="hero-orbit orbit-one"/><div className="hero-orbit orbit-two"/><div className="floating-file rear"><span>THE FINAL FILES</span><div className="file-lines"/><LockKeyhole size={21}/></div><div className="floating-file front"><div className="mini-art"><span>olive</span><div className="mini-leaf"/></div><div className="mini-card-footer"><span>Something worth<br/><strong>handing over.</strong></span><span className="mini-arrow"><ArrowUpRight size={19}/></span></div></div><div className="secure-float"><span><Check size={14}/></span>{en.protected}</div><div className="hero-steps"><span>01 {en.preview}</span><i/><span>02 {en.payment}</span><i/><span>03 {en.originals}</span></div></div></section>
    {isExample && <div className="example-notice"><span><Sparkles size={14}/><strong>{en.sampleBanner}</strong></span><p>{en.sampleHelp}</p></div>}
    <section className="stats" aria-label={en.workspace}><div><span className="stat-icon"><FolderClosed size={19}/></span><div><p>{en.total}</p><strong>{items.length.toString().padStart(2, '0')}</strong></div><span className="stat-detail">{en.all}</span></div><div><span className="stat-icon amber"><ArrowUpRight size={19}/></span><div><p>{en.awaiting}</p><strong>{items.filter(h => h.status === 'awaiting-client').length.toString().padStart(2, '0')}</strong></div><span className="stat-dot amber-dot"/></div><div><span className="stat-icon gray"><FileImage size={19}/></span><div><p>{en.drafts}</p><strong>{items.filter(h => h.status === 'draft').length.toString().padStart(2, '0')}</strong></div><span className="stat-dot"/></div></section>
    <section className="projects"><div className="projects-heading"><div><h2>{en.projectsTitle}</h2><p>{en.projectsSubtitle}</p></div><button className="button primary" onClick={newDraft}><Plus size={17}/>{en.newHandoff}</button></div><div className="project-controls"><div className="tabs" aria-label={en.all}>{[['all', en.all], ['awaiting-client', en.awaiting], ['draft', en.drafts]].map(([key, label]) => <button key={key} onClick={() => setFilter(key)} aria-pressed={filter === key} className={filter === key ? 'active' : ''}>{label}{key === 'all' && <span>{items.length}</span>}</button>)}</div><div className="search-controls"><label className="search-input"><Search size={16}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder={en.search} aria-label={en.search}/></label><div className="view-toggle"><button onClick={() => setView('grid')} className={view === 'grid' ? 'selected' : ''} aria-label={en.grid} aria-pressed={view === 'grid'}><Grid2X2 size={17}/></button><button onClick={() => setView('list')} className={view === 'list' ? 'selected' : ''} aria-label={en.list} aria-pressed={view === 'list'}><List size={17}/></button></div></div></div><div className="results-bar"><span>{filtered.length} {en.handoffs.toLowerCase()}</span><label className="sort-select"><select aria-label={en.newest} value={sort} onChange={event => setSort(event.target.value)}><option value="newest">{en.newest}</option><option value="oldest">{en.oldest}</option></select><ChevronDown size={14}/></label></div>
    <div className={`project-grid ${view === 'list' ? 'list-view' : ''}`}>{filtered.map(h => <button className="project-card" key={h.id} onClick={() => navigate(isExample ? `/example/${h.id}` : `/draft/${h.id}`)}>{isExample ? <Artwork kind={h.id} compact/> : h.files.length ? <div className="actual-cover"><img src={`/api/previews/${h.id}/${h.files[0].id}`} alt=""/></div> : <div className="blank-cover"><FolderClosed size={38}/><span>{en.draft}</span></div>}<div className="card-content"><div className="card-topline"><span className={`status-pill ${h.status}`}><span/>{statuses[h.status]}</span><span className="card-file-count"><FileImage size={13}/>{h.files.length} {en.files}</span></div><h3>{h.title}</h3><p className="card-client">{en.for} <span>{h.clientLabel}</span></p><div className="card-bottom"><strong>{new Intl.NumberFormat('en').format(Number(h.amount))}<span>{h.currency}</span></strong><span className="card-open" aria-label={en.open}><ArrowUpRight size={19}/></span></div></div></button>)}
    {!search && filter === 'all' && <button className="create-card" onClick={newDraft}><span className="create-icon"><Plus size={24}/></span><strong>{en.createAnother}</strong><p>{en.newCardBody}</p><span>{en.newHandoff}<ArrowRight size={15}/></span></button>}</div>
    {!filtered.length && (search || filter !== 'all') && <div className="empty-state small"><Search size={28}/><h3>{en.noResults}</h3><p>{en.noResultsBody}</p><button className="button secondary" onClick={() => { setFilter('all'); setSearch(''); }}>{en.clear}</button></div>}</section></>}
    {error && <p role="alert" className="error">{error}</p>}<footer><span>{en.brand}<span className="footer-star">✳</span>{en.tagline}</span><span><span className="connection-dot"/>{en.development}</span></footer>
  </div></main></div>
  {walletOpen && <WalletModal close={() => setWalletOpen(false)} connected={setUser}/>}
  {draftOpen && <DraftModal user={user} handoff={editing} close={() => setDraftOpen(false)} saved={handoff => { update(handoff); navigate(`/draft/${handoff.id}`); }} signIn={() => setWalletOpen(true)}/>}
  {toast && <div className="toast" role="status"><Check size={17}/>{toast}<button className="icon-button" aria-label={en.close} onClick={() => setToast('')}><X size={16}/></button></div>}
  </div>;
}
