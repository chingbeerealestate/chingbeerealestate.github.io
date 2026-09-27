(() => {
  const config = window.CHINGBEE_FIREBASE_CONFIG;
  if (!config) return;

  const ROOM_CODE = '4677';
  const ADMIN_EMAIL = 'isaacjacobdajay@gmail.com';
  const $ = (s) => document.querySelector(s);
  let db, auth, app;
  let session = null;
  let pendingMedia = [];
  let unsubProfiles = null;
  let unsubPosts = null;

  const esc = (v = '') => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normEmail = (v = '') => v.trim().toLowerCase();
  const profileId = (email) => btoa(email).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const handle = (p) => (p?.username || p?.name || p?.email || '').trim().toLowerCase();
  const initials = (name, email) => (name || email || '?').trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase() || '?';
  const show = (id) => ['#teamGate', '#teamRoom', '#teamPending', '#teamAdmin'].forEach((x) => $(x).hidden = x !== id);
  const setStatus = (msg) => { const el = $('#teamLockStatus'); if (el) el.textContent = msg; };

  async function boot() {
    const [{ initializeApp }, { getAuth, signInAnonymously }, firestore] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'),
    ]);
    app = initializeApp(config);
    auth = getAuth(app);
    db = firestore.getFirestore(app);
    await signInAnonymously(auth);
    wire(firestore);
    setStatus('Cloud mode on. No GitHub login needed.');
    document.querySelectorAll('.status-line').forEach((el) => {
      if (el.textContent.includes('Firebase-ready')) el.textContent = 'Cloud mode: live chat and profile approvals sync through Firebase. No GitHub login needed.';
    });
  }

  function renderProfiles(items, firestore) {
    const list = $('#profileList');
    if (!list) return;
    list.innerHTML = items.length ? items.map((p) => {
      const owner = p.email === ADMIN_EMAIL;
      return `<div class="item"><div class="profile-card"><div class="avatar">${esc(initials(handle(p), p.email))}</div><div class="profile-meta"><strong>@${esc(handle(p))}</strong><small>${esc(p.email)}</small><small>${esc(p.role || 'Member')}${p.title ? ` · ${esc(p.title)}` : ''}</small></div><div><span class="tag">${esc(p.status || 'Pending')}</span></div></div><div class="profile-editor"><input data-user="${esc(p.id)}" value="${esc(handle(p))}" placeholder="username" ${owner ? 'readonly' : ''}><input data-role="${esc(p.id)}" value="${esc(p.role || 'Member')}" placeholder="role" ${owner ? 'readonly' : ''}><input data-title="${esc(p.id)}" value="${esc(p.title || '')}" placeholder="title" ${owner ? 'readonly' : ''}><button class="btn primary" data-save-profile="${esc(p.id)}">Save</button></div><div class="room-toolbar" style="margin:10px 0 0">${p.status !== 'Approved' ? `<button class="btn primary" data-approve="${esc(p.id)}">Accept user</button>` : ''}${!owner ? `<button class="btn" data-remove-profile="${esc(p.id)}">Remove user</button>` : '<span class="status-line">Owner admin is protected.</span>'}</div></div>`;
    }).join('') : '<p class="sub">No profiles yet.</p>';
    list.querySelectorAll('[data-approve]').forEach((btn) => btn.onclick = async () => {
      if (session?.email !== ADMIN_EMAIL) return setStatus('Admin access is locked to Jacob only.');
      await firestore.updateDoc(firestore.doc(db, 'teamProfiles', btn.dataset.approve), { status: 'Approved', approvedAt: Date.now() });
    });
    list.querySelectorAll('[data-remove-profile]').forEach((btn) => btn.onclick = async () => {
      if (session?.email !== ADMIN_EMAIL) return setStatus('Admin access is locked to Jacob only.');
      const item = items.find((p) => p.id === btn.dataset.removeProfile);
      if (!item || item.email === ADMIN_EMAIL) return;
      if (!confirm(`Remove @${handle(item)} from the CHINGBEE registry?`)) return;
      await firestore.deleteDoc(firestore.doc(db, 'teamProfiles', btn.dataset.removeProfile));
    });
    list.querySelectorAll('[data-save-profile]').forEach((btn) => btn.onclick = async () => {
      if (session?.email !== ADMIN_EMAIL) return setStatus('Admin access is locked to Jacob only.');
      const id = btn.dataset.saveProfile;
      const username = normEmail(list.querySelector(`[data-user=\"${id}\"]`)?.value || '');
      const role = (list.querySelector(`[data-role=\"${id}\"]`)?.value || 'Member').trim();
      const title = (list.querySelector(`[data-title=\"${id}\"]`)?.value || '').trim();
      const current = items.find((p) => p.id === id);
      const isAdmin = current?.email === ADMIN_EMAIL;
      await firestore.updateDoc(firestore.doc(db, 'teamProfiles', id), { name: isAdmin ? 'jacob' : username, username: isAdmin ? 'jacob' : username, role: isAdmin ? 'Admin' : role, title: isAdmin ? 'Operations Manager' : title, ...(isAdmin ? { status: 'Approved', admin: true } : {}), updatedAt: Date.now() });
    });
  }

  function renderPosts(items) {
    const stream = $('#teamStream');
    if (!stream) return;
    stream.innerHTML = items.length ? items.map((post) => `<div class="room-post"><div class="post-head"><div class="avatar">${esc(initials(post.name, post.email))}</div><div class="profile-meta"><b>@${esc(handle(post))}</b><small>${esc(post.email)}${post.title ? ` · ${esc(post.title)}` : ''}</small></div><span class="tag">Update</span></div><p class="post-copy">${esc(post.text)}</p>${post.media?.length ? `<div class="room-media">${post.media.map((src) => `<img src="${esc(src)}" alt="Team media">`).join('')}</div>` : ''}<time class="post-time">${new Date(post.createdAt || Date.now()).toLocaleString()}</time></div>`).join('') : '<p class="sub">No team updates yet.</p>';
  }

  function listen(firestore) {
    unsubProfiles?.();
    unsubPosts?.();
    unsubProfiles = firestore.onSnapshot(firestore.query(firestore.collection(db, 'teamProfiles'), firestore.orderBy('createdAt', 'asc')), (snap) => {
      renderProfiles(snap.docs.map((d) => ({ id: d.id, ...d.data() })), firestore);
    });
    unsubPosts = firestore.onSnapshot(firestore.query(firestore.collection(db, 'teamPosts'), firestore.orderBy('createdAt', 'desc')), (snap) => {
      renderPosts(snap.docs.map((d) => d.data()));
    });
  }

  function wire(firestore) {
    listen(firestore);

    $('#enterTeam').onclick = async () => {
      const code = $('#teamCode').value.trim();
      const email = normEmail($('#teamEmail').value);
      const name = normEmail($('#teamLoginName').value);
      if (code !== ROOM_CODE) return setStatus('Wrong room code.');
      if (!email || !name) return setStatus('Enter both email and username.');
      const id = profileId(email);
      const ref = firestore.doc(db, 'teamProfiles', id);
      const snap = await firestore.getDoc(ref);
      if (!snap.exists()) {
        await firestore.setDoc(ref, { email, name, username: name, role: email === ADMIN_EMAIL ? 'Admin' : 'Member', title: email === ADMIN_EMAIL ? 'Operations Manager' : '', status: email === ADMIN_EMAIL ? 'Approved' : 'Pending', admin: email === ADMIN_EMAIL, createdAt: Date.now() });
        session = { email, name, username: name, role: email === ADMIN_EMAIL ? 'Admin' : 'Member', title: email === ADMIN_EMAIL ? 'Operations Manager' : '', status: email === ADMIN_EMAIL ? 'Approved' : 'Pending', admin: email === ADMIN_EMAIL };
      } else {
        const existing = snap.data();
        await firestore.updateDoc(ref, { name, username: name, ...(email === ADMIN_EMAIL ? { role: 'Admin', title: 'Operations Manager', status: 'Approved', admin: true } : {}), lastSeenAt: Date.now() });
        session = { email, name, username: name, ...existing, ...(email === ADMIN_EMAIL ? { role: 'Admin', title: 'Operations Manager', status: 'Approved', admin: true } : {}) };
      }
      if (session.status === 'Approved') {
        $('#teamName').value = `@${handle(session)} — ${session.title || session.role || 'Member'} — ${session.email}`;
        show('#teamRoom');
      } else {
        $('#pendingText').textContent = `@${name}, your profile is pending approval. Jacob/admin needs to approve ${email} before this profile can post.`;
        show('#teamPending');
      }
    };

    $('#adminTeam').onclick = async () => {
      const code = $('#teamCode').value.trim();
      const email = normEmail($('#teamEmail').value);
      if (code !== ROOM_CODE) return setStatus('Wrong room code.');
      if (email !== ADMIN_EMAIL) return setStatus('Admin access is locked to Jacob only.');
      const ref = firestore.doc(db, 'teamProfiles', profileId(ADMIN_EMAIL));
      const snap = await firestore.getDoc(ref);
      if (!snap.exists()) await firestore.setDoc(ref, { email: ADMIN_EMAIL, name: 'jacob', username: 'jacob', role: 'Admin', title: 'Operations Manager', status: 'Approved', admin: true, createdAt: Date.now() });
      else await firestore.updateDoc(ref, { name: 'jacob', username: 'jacob', role: 'Admin', title: 'Operations Manager', status: 'Approved', admin: true, lastSeenAt: Date.now() });
      session = { email: ADMIN_EMAIL, name: 'jacob', username: 'jacob', role: 'Admin', title: 'Operations Manager', status: 'Approved', admin: true };
      show('#teamAdmin');
    };

    $('#backToLogin').onclick = () => show('#teamGate');
    $('#closeAdmin').onclick = () => show('#teamGate');
    $('#lockTeam').onclick = () => { session = null; show('#teamGate'); };

    $('#teamMedia').onchange = async (e) => {
      pendingMedia = [];
      const files = [...e.target.files].slice(0, 4);
      await Promise.all(files.map((file) => new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => { pendingMedia.push(r.result); resolve(); };
        r.readAsDataURL(file);
      })));
    };

    $('#teamForm').onsubmit = async (e) => {
      e.preventDefault();
      if (!session) return;
      const text = new FormData(e.target).get('text').trim();
      if (!text) return;
      const profileSnap = await firestore.getDoc(firestore.doc(db, 'teamProfiles', profileId(session.email)));
      if (!profileSnap.exists() || profileSnap.data().status !== 'Approved') return;
      await firestore.addDoc(firestore.collection(db, 'teamPosts'), { email: session.email, name: handle(session), username: handle(session), title: session.title || '', text, media: pendingMedia, createdAt: Date.now() });
      pendingMedia = [];
      $('#teamMedia').value = '';
      e.target.reset();
    };
  }

  boot().catch((err) => {
    console.error(err);
    setStatus('Cloud mode failed to start. Check Firebase config.');
  });
})();

