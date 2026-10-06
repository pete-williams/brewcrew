// public/admin.js
// Dedicated Administrator & Configuration Portal Logic for BrewCrew

// 1. Initialize Firebase
const firebaseConfig = window.firebaseConfig;
if (!firebaseConfig || !firebaseConfig.apiKey) {
  console.error("Firebase config not loaded.");
}

firebase.initializeApp(firebaseConfig || {});
const auth = firebase.auth();
const db = firebase.firestore();
const functions = firebase.functions();

// Global State
let currentAdminUser = null;
let currentAdminProfile = null;
let activeAdminTab = "crew";

let allUsersMap = new Map();
let currentShiftsDocs = [];
let allRegistrationsDocs = [];
let blockedEmailsMap = new Map();
let currentFestivalConfig = {
  festivalName: "BrewCrew",
  festivalWebsite: "",
  festivalLogoUrl: "",
  volunteerManager: { name: "", email: "", phone: "" },
  sessions: []
};
let currentIncentivesConfig = {
  welcomeTitle: "Welcome to BrewCrew!",
  welcomeText: "Join our volunteer team to earn rewards while enjoying the festival.",
  items: []
};
let currentRolesConfig = { roles: {} };

// Crew Directory State (Scalable for 50-100 Volunteers)
let crewSearchQuery = "";
let crewRoleFilter = "ALL";
let crewStatusFilter = "ALL";
let crewSortMode = "name-asc";
let crewPageSize = 25;
let crewCurrentPage = 1;
let crewGroupFilter = "ALL"; // "ALL" | "NONE" | groupId

// Group Management State
let allGroupsMap = new Map();
let editingGroupId = null;

// Shift Filter & Organization State (Day -> Session -> Area OR Time)
let shiftSelectedDayDate = "";
let shiftSelectedSessionId = "ALL";
let shiftGroupingMode = (function() {
  try {
    return localStorage.getItem("brewcrew_admin_shift_grouping") || "area";
  } catch (e) {
    return "area";
  }
})();
let activeRosterShiftId = null;
let shiftSessionFilter = "ALL"; // legacy compatibility fallback

// Auth Gate Listener
auth.onAuthStateChanged(async (user) => {
  const gateEl = document.getElementById("admin-auth-gate");
  const appEl = document.getElementById("admin-app");
  const gateTitle = document.getElementById("gate-title");
  const gateMsg = document.getElementById("gate-message");
  const gateAction = document.getElementById("gate-action");

  if (!user) {
    if (gateTitle) gateTitle.innerText = "Authentication Required";
    if (gateMsg) gateMsg.innerText = "Please sign in to access the BrewCrew Administrator Portal.";
    if (gateAction) gateAction.classList.remove("hidden");
    return;
  }

  currentAdminUser = user;

  try {
    const userDoc = await db.collection("users").doc(user.uid).get();
    if (!userDoc.exists || userDoc.data().role !== "admin") {
      if (gateTitle) gateTitle.innerText = "Access Restricted";
      if (gateMsg) gateMsg.innerText = "Your account does not possess administrator privileges. Only designated festival administrators can access this console.";
      if (gateAction) gateAction.classList.remove("hidden");
      return;
    }

    currentAdminProfile = userDoc.data();

    if (currentAdminProfile.disabled) {
      if (gateTitle) gateTitle.innerText = "Account Deactivated";
      if (gateMsg) gateMsg.innerText = "This administrator account has been deactivated. Please contact festival leadership.";
      if (gateAction) gateAction.classList.remove("hidden");
      await auth.signOut();
      return;
    }

    // Authorized Admin -> Reveal App
    if (gateEl) gateEl.classList.add("hidden");
    if (appEl) {
      appEl.classList.remove("hidden");
      appEl.classList.add("flex");
    }

    populateAdminHeader();
    initializeRealtimeSubscriptions();
    handleHashNavigation();
  } catch (err) {
    console.error("Admin verification error:", err);
    if (gateTitle) gateTitle.innerText = "Verification Error";
    if (gateMsg) gateMsg.innerText = "Failed to verify administrator credentials: " + err.message;
    if (gateAction) gateAction.classList.remove("hidden");
  }
});

function populateAdminHeader() {
  const nameEl = document.getElementById("admin-user-name");
  const emailEl = document.getElementById("admin-user-email");
  const initialsEl = document.getElementById("admin-avatar-initials");
  const imgEl = document.getElementById("admin-avatar-img");

  const displayName = currentAdminProfile?.fullName || currentAdminUser?.displayName || "Administrator";
  const email = currentAdminProfile?.email || currentAdminUser?.email || "";
  const photo = currentAdminProfile?.photoURL || currentAdminUser?.photoURL || "";

  if (nameEl) nameEl.textContent = displayName;
  if (emailEl) emailEl.textContent = email;

  if (photo && imgEl && initialsEl) {
    imgEl.src = photo;
    imgEl.classList.remove("hidden");
    initialsEl.classList.add("hidden");
  } else if (initialsEl) {
    initialsEl.textContent = (displayName[0] || "A").toUpperCase();
    if (imgEl) imgEl.classList.add("hidden");
  }
}

function adminSignOut() {
  auth.signOut().then(() => {
    window.location.href = "index.html";
  }).catch((err) => {
    console.error("Sign out error:", err);
  });
}

// ============================================================================
// REAL-TIME FIRESTORE SUBSCRIPTIONS
// ============================================================================
function initializeRealtimeSubscriptions() {
  // 1. Users Collection
  db.collection("users").onSnapshot((snapshot) => {
    allUsersMap.clear();
    snapshot.docs.forEach((doc) => {
      allUsersMap.set(doc.id, { id: doc.id, ...doc.data() });
    });
    updateCrewSummaryStats();
    renderCrewDirectory();
    renderGroupFilterOptions();
    renderManageGroupsList();
  }, (err) => console.warn("Users subscription error:", err));

  // 1b. Groups Collection
  db.collection("groups").orderBy("name").onSnapshot((snapshot) => {
    allGroupsMap.clear();
    snapshot.docs.forEach((doc) => {
      allGroupsMap.set(doc.id, { id: doc.id, ...doc.data() });
    });
    if (crewGroupFilter !== "ALL" && crewGroupFilter !== "NONE" && !allGroupsMap.has(crewGroupFilter)) {
      crewGroupFilter = "ALL";
    }
    renderGroupFilterOptions();
    renderCrewDirectory();
    renderManageGroupsList();
  }, (err) => console.warn("Groups subscription error:", err));

  // 2. Shifts Collection
  db.collection("shifts").onSnapshot((snapshot) => {
    currentShiftsDocs = snapshot.docs;
    const badgeEl = document.getElementById("badge-shifts-count");
    if (badgeEl) badgeEl.textContent = snapshot.size;
    renderShiftsNavigation();
    renderShiftsPanel();
    if (activeRosterShiftId) {
      renderRosterModalContent(activeRosterShiftId);
    }
    renderSessionsTable();
    renderRolesTable();
  }, (err) => console.warn("Shifts subscription error:", err));

  // 3. Registrations Collection (Realtime for occupancy and volunteer shift count)
  db.collection("registrations").where("status", "==", "confirmed").onSnapshot((snapshot) => {
    allRegistrationsDocs = snapshot.docs;
    renderCrewDirectory();
    renderShiftsNavigation();
    renderShiftsPanel();
    if (activeRosterShiftId) {
      renderRosterModalContent(activeRosterShiftId);
    }
  }, (err) => console.warn("Registrations subscription error:", err));

  // 4. Festival Configuration
  db.collection("config").doc("festival").onSnapshot((doc) => {
    if (doc.exists) {
      currentFestivalConfig = doc.data();
      const nameEl = document.getElementById("header-festival-name");
      if (nameEl && currentFestivalConfig.festivalName) {
        nameEl.textContent = currentFestivalConfig.festivalName;
      }
      populateFestivalConfigForm();
      renderSessionsTable();
      renderShiftsNavigation();
      renderShiftsPanel();
    }
  }, (err) => console.warn("Festival config subscription error:", err));

  // 5. Incentives Configuration
  db.collection("config").doc("incentives").onSnapshot((doc) => {
    if (doc.exists) {
      currentIncentivesConfig = doc.data();
      populateIncentivesForm();
      renderIncentivesTable();
    }
  }, (err) => console.warn("Incentives config subscription error:", err));

  // 6. Roles Configuration
  db.collection("config").doc("roles").onSnapshot((doc) => {
    if (doc.exists) {
      currentRolesConfig = doc.data();
      renderRolesTable();
    }
  }, (err) => console.warn("Roles config subscription error:", err));

  // 7. Blocked Emails Blacklist
  db.collection("blockedEmails").onSnapshot((snapshot) => {
    blockedEmailsMap.clear();
    snapshot.docs.forEach((doc) => {
      blockedEmailsMap.set(doc.id, { id: doc.id, ...doc.data() });
    });
    const badge = document.getElementById("badge-blocked-count");
    const stat = document.getElementById("stat-blocked-count");
    if (badge) badge.textContent = snapshot.size;
    if (stat) stat.textContent = snapshot.size;
    renderBlockedEmailsTable();
  }, (err) => console.warn("Blocked emails subscription error:", err));
}

// ============================================================================
// TAB NAVIGATION & HASH ROUTING
// ============================================================================
const VALID_TABS = ["crew", "sessions", "shifts", "incentives", "roles", "broadcast", "blocked"];

function switchAdminTab(tabName) {
  if (!VALID_TABS.includes(tabName)) tabName = "crew";
  activeAdminTab = tabName;

  VALID_TABS.forEach((t) => {
    const btn = document.getElementById(`tab-btn-${t}`);
    const panel = document.getElementById(`panel-${t}`);
    const isActive = t === tabName;

    if (panel) {
      if (isActive) {
        panel.classList.remove("hidden");
      } else {
        panel.classList.add("hidden");
      }
    }

    if (btn) {
      if (isActive) {
        btn.className = "admin-tab-btn flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition min-h-[44px] bg-amber-700 text-white shadow-xs";
      } else {
        btn.className = "admin-tab-btn flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition min-h-[44px] text-amber-200/90 hover:text-white hover:bg-amber-900/60";
      }
    }
  });

  if (window.location.hash !== `#${tabName}`) {
    window.location.hash = `#${tabName}`;
  }

  if (tabName === "shifts") {
    renderShiftsNavigation();
    renderShiftsPanel();
  }

  if (tabName === "broadcast") {
    initOrRefreshCommConsole();
  }
}

function handleHashNavigation() {
  const hash = (window.location.hash || "").replace("#", "").trim();
  if (VALID_TABS.includes(hash)) {
    switchAdminTab(hash);
  } else {
    switchAdminTab("crew");
  }
}

window.addEventListener("hashchange", handleHashNavigation);

// ============================================================================
// TAB 1: CREW & VOLUNTEER DIRECTORY (50-100 Volunteers Scalability)
// ============================================================================
function updateCrewSummaryStats() {
  let countVolunteers = 0;
  let countManagers = 0;
  let countAdmins = 0;
  let countDisabled = 0;

  allUsersMap.forEach((u) => {
    if (u.disabled) countDisabled++;
    const r = u.role || "volunteer";
    if (r === "admin") countAdmins++;
    else if (r === "manager") countManagers++;
    else countVolunteers++;
  });

  const total = allUsersMap.size;
  const statTotal = document.getElementById("stat-total-crew");
  const statVol = document.getElementById("stat-volunteers");
  const statMgr = document.getElementById("stat-managers");
  const statAdm = document.getElementById("stat-admins");
  const statDis = document.getElementById("stat-disabled");
  const badgeCrew = document.getElementById("badge-crew-count");

  if (statTotal) statTotal.textContent = total;
  if (statVol) statVol.textContent = countVolunteers;
  if (statMgr) statMgr.textContent = countManagers;
  if (statAdm) statAdm.textContent = countAdmins;
  if (statDis) statDis.textContent = countDisabled;
  if (badgeCrew) badgeCrew.textContent = total;
}

function handleCrewSearch(query) {
  crewSearchQuery = (query || "").trim().toLowerCase();
  crewCurrentPage = 1;
  renderCrewDirectory();
}

function setCrewRoleFilter(role) {
  crewRoleFilter = role;
  crewCurrentPage = 1;

  ["ALL", "volunteer", "manager", "admin"].forEach((r) => {
    const pill = document.getElementById(`role-pill-${r}`);
    if (!pill) return;
    if (r === role) {
      pill.className = "crew-role-pill px-2.5 py-1 rounded-full text-2xs font-bold transition bg-amber-700 text-white shadow-2xs";
    } else {
      pill.className = "crew-role-pill px-2.5 py-1 rounded-full text-2xs font-bold transition bg-stone-100 text-slate-600 hover:bg-stone-200";
    }
  });

  renderCrewDirectory();
}

function setCrewStatusFilter(status) {
  crewStatusFilter = status;
  crewCurrentPage = 1;

  ["ALL", "active", "disabled"].forEach((s) => {
    const pill = document.getElementById(`status-pill-${s}`);
    if (!pill) return;
    if (s === status) {
      pill.className = "crew-status-pill px-2 py-0.5 rounded-md text-2xs font-bold transition bg-slate-800 text-white shadow-2xs";
    } else {
      pill.className = "crew-status-pill px-2 py-0.5 rounded-md text-2xs font-bold transition bg-stone-100 text-slate-600 hover:bg-stone-200 border border-slate-300";
    }
  });

  renderCrewDirectory();
}

function handleCrewSortChange(val) {
  crewSortMode = val;
  renderCrewDirectory();
}

function handleCrewPageSizeChange(val) {
  crewPageSize = parseInt(val, 10) || 25;
  crewCurrentPage = 1;
  renderCrewDirectory();
}

function getVolunteerShiftCount(userId) {
  return allRegistrationsDocs.filter((doc) => doc.data().userId === userId).length;
}

function getFilteredAndSortedCrew() {
  const users = Array.from(allUsersMap.values());

  // Filter
  const filtered = users.filter((u) => {
    // Role filter
    if (crewRoleFilter !== "ALL" && (u.role || "volunteer") !== crewRoleFilter) {
      return false;
    }
    // Status filter
    if (crewStatusFilter === "active" && u.disabled) return false;
    if (crewStatusFilter === "disabled" && !u.disabled) return false;

    // Group filter
    if (crewGroupFilter !== "ALL") {
      const gid = resolveUserGroup(u).id;
      if (crewGroupFilter === "NONE" ? gid !== null : gid !== crewGroupFilter) return false;
    }

    // Search query
    if (crewSearchQuery) {
      const name = (u.fullName || "").toLowerCase();
      const email = (u.email || "").toLowerCase();
      const phone = (u.phoneNumber || "").toLowerCase();
      const group = (resolveUserGroup(u).name || "").toLowerCase();
      return name.includes(crewSearchQuery) ||
             email.includes(crewSearchQuery) ||
             phone.includes(crewSearchQuery) ||
             group.includes(crewSearchQuery);
    }
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    const nameA = (a.fullName || a.email || "").toLowerCase();
    const nameB = (b.fullName || b.email || "").toLowerCase();

    if (crewSortMode === "name-desc") {
      return nameB.localeCompare(nameA);
    }
    if (crewSortMode === "role") {
      const order = { admin: 1, manager: 2, volunteer: 3 };
      const rA = order[a.role || "volunteer"] || 9;
      const rB = order[b.role || "volunteer"] || 9;
      if (rA !== rB) return rA - rB;
      return nameA.localeCompare(nameB);
    }
    if (crewSortMode === "shifts-desc") {
      const sA = getVolunteerShiftCount(a.id);
      const sB = getVolunteerShiftCount(b.id);
      if (sB !== sA) return sB - sA;
      return nameA.localeCompare(nameB);
    }
    if (crewSortMode === "status") {
      const disA = Boolean(a.disabled);
      const disB = Boolean(b.disabled);
      if (disA !== disB) return disA ? 1 : -1;
      return nameA.localeCompare(nameB);
    }
    if (crewSortMode === "group") {
      // Users with a group first (A-Z by group), then ungrouped; ties by name
      const gA = (resolveUserGroup(a).name || "").toLowerCase();
      const gB = (resolveUserGroup(b).name || "").toLowerCase();
      if (gA !== gB) {
        if (!gA) return 1;
        if (!gB) return -1;
        return gA.localeCompare(gB);
      }
      return nameA.localeCompare(nameB);
    }
    // default: name-asc
    return nameA.localeCompare(nameB);
  });

  return filtered;
}

function renderCrewDirectory() {
  const tableBody = document.getElementById("crew-table-body");
  const cardsContainer = document.getElementById("crew-cards-container");
  const paginationInfo = document.getElementById("crew-pagination-info");
  const paginationControls = document.getElementById("crew-pagination-controls");

  if (!tableBody || !cardsContainer) return;

  const filteredUsers = getFilteredAndSortedCrew();
  const totalCount = filteredUsers.length;

  if (totalCount === 0) {
    tableBody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400 italic">No crew members match the selected filters.</td></tr>`;
    cardsContainer.innerHTML = `<div class="p-6 text-center text-slate-400 italic text-xs">No crew members match the selected filters.</div>`;
    if (paginationInfo) paginationInfo.textContent = "Showing 0 to 0 of 0 crew members";
    if (paginationControls) paginationControls.innerHTML = "";
    return;
  }

  // Pagination calculation
  const totalPages = Math.ceil(totalCount / crewPageSize);
  if (crewCurrentPage > totalPages) crewCurrentPage = totalPages;
  if (crewCurrentPage < 1) crewCurrentPage = 1;

  const startIndex = (crewCurrentPage - 1) * crewPageSize;
  const endIndex = Math.min(startIndex + crewPageSize, totalCount);
  const pageUsers = filteredUsers.slice(startIndex, endIndex);

  // Update Pagination Info
  if (paginationInfo) {
    paginationInfo.innerHTML = `Showing <strong class="text-slate-700 font-semibold tabular-nums">${startIndex + 1}</strong> to <strong class="text-slate-700 font-semibold tabular-nums">${endIndex}</strong> of <strong class="text-slate-700 font-semibold tabular-nums">${totalCount}</strong> crew members`;
  }

  // Build Pagination Controls
  if (paginationControls) {
    paginationControls.innerHTML = "";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.disabled = crewCurrentPage === 1;
    prevBtn.className = `px-2.5 py-1 rounded-md text-xs font-semibold border ${crewCurrentPage === 1 ? 'border-slate-200 text-slate-300 cursor-not-allowed' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`;
    prevBtn.textContent = "Previous";
    prevBtn.onclick = () => { if (crewCurrentPage > 1) { crewCurrentPage--; renderCrewDirectory(); } };
    paginationControls.appendChild(prevBtn);

    // Page indicator
    const pageIndicator = document.createElement("span");
    pageIndicator.className = "px-2 text-2xs font-bold text-slate-500 tabular-nums";
    pageIndicator.textContent = `Page ${crewCurrentPage} of ${totalPages}`;
    paginationControls.appendChild(pageIndicator);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.disabled = crewCurrentPage === totalPages;
    nextBtn.className = `px-2.5 py-1 rounded-md text-xs font-semibold border ${crewCurrentPage === totalPages ? 'border-slate-200 text-slate-300 cursor-not-allowed' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`;
    nextBtn.textContent = "Next";
    nextBtn.onclick = () => { if (crewCurrentPage < totalPages) { crewCurrentPage++; renderCrewDirectory(); } };
    paginationControls.appendChild(nextBtn);
  }

  // 1. Render Desktop Table Rows
  tableBody.innerHTML = "";
  pageUsers.forEach((u) => {
    const tr = document.createElement("tr");
    tr.className = `hover:bg-amber-50/40 transition ${u.disabled ? 'bg-rose-50/30' : ''}`;

    const isSelf = currentAdminUser && u.id === currentAdminUser.uid;
    const role = u.role || "volunteer";
    const shiftsCount = getVolunteerShiftCount(u.id);

    let roleBadgeClass = "bg-amber-100 text-amber-900 border border-amber-300";
    let roleText = "Volunteer";
    if (role === "admin") {
      roleBadgeClass = "bg-purple-100 text-purple-900 border border-purple-300";
      roleText = "Admin";
    } else if (role === "manager") {
      roleBadgeClass = "bg-blue-100 text-blue-900 border border-blue-300";
      roleText = "Shift Mgr";
    }

    const statusBadge = u.disabled ?
      `<span class="px-2 py-0.5 rounded-full text-2xs font-bold bg-rose-100 text-rose-800 border border-rose-300">Disabled</span>` :
      `<span class="px-2 py-0.5 rounded-full text-2xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-300">Active</span>`;

    tr.innerHTML = `
      <td class="p-3">
        <div class="flex items-center space-x-2.5">
          <button type="button" onclick="openAdminEditUserModal('${u.id}')"
            title="Click to view & edit ${escapeJs(u.fullName || 'User')}'s profile"
            class="group/user flex items-center space-x-2.5 text-left cursor-pointer focus:outline-none focus:ring-2 focus:ring-amber-500 rounded-lg p-1 -m-1 hover:bg-amber-100/60 transition">
            ${u.photoURL ? `
              <img src="${escapeHtml(u.photoURL)}" class="w-8 h-8 rounded-full object-cover shrink-0 border border-amber-300 shadow-2xs group-hover/user:ring-2 group-hover/user:ring-amber-500 transition" alt="Avatar" />
            ` : `
              <div class="w-8 h-8 rounded-full bg-amber-200 text-amber-900 font-bold flex items-center justify-center text-xs shrink-0 border border-amber-300 group-hover/user:ring-2 group-hover/user:ring-amber-500 transition">
                ${escapeHtml((u.fullName || u.email || "U")[0].toUpperCase())}
              </div>
            `}
            <div>
              <p class="font-bold text-slate-800 text-xs flex items-center gap-1.5 group-hover/user:text-amber-900 group-hover/user:underline">
                <span>${escapeHtml(u.fullName || "Volunteer")}</span>
                <svg class="w-3 h-3 text-slate-400 group-hover/user:text-amber-700 opacity-0 group-hover/user:opacity-100 transition shrink-0"><use href="#icon-edit" /></svg>
                ${isSelf ? '<span class="text-2xs text-amber-800 font-bold bg-amber-100 px-1 py-0.2 rounded no-underline">(You)</span>' : ''}
              </p>
              <div class="mt-0.5" onclick="event.stopPropagation()">${renderUserGroupBadge(u)}</div>
            </div>
          </button>
        </div>
      </td>
      <td class="p-3 text-slate-600 font-mono text-2xs">${escapeHtml(u.email || "—")}</td>
      <td class="p-3 text-slate-700 text-xs font-mono">${escapeHtml(u.phoneNumber || "—")}</td>
      <td class="p-3 text-center">
        ${isSelf ? `
          <span class="px-2 py-0.5 rounded-full text-2xs font-bold ${roleBadgeClass}">${roleText}</span>
        ` : `
          <select onchange="handleRoleChange('${u.id}', this.value, '${escapeJs(u.fullName || u.email)}', this)"
            class="text-xs p-1 rounded-md border border-slate-300 bg-white font-semibold focus:ring-2 focus:ring-amber-500">
            <option value="volunteer" ${role === 'volunteer' ? 'selected' : ''}>Volunteer</option>
            <option value="manager" ${role === 'manager' ? 'selected' : ''}>Shift Manager</option>
            <option value="admin" ${role === 'admin' ? 'selected' : ''}>Administrator</option>
          </select>
        `}
      </td>
      <td class="p-3 text-center">
        <span class="px-2 py-0.5 rounded-full text-2xs font-bold tabular-nums ${shiftsCount > 0 ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-500'}">
          ${shiftsCount} shift${shiftsCount === 1 ? '' : 's'}
        </span>
      </td>
      <td class="p-3 text-center">${statusBadge}</td>
      <td class="p-3 text-right">
        <div class="flex items-center justify-end gap-1.5">
          <button type="button" onclick="openAdminEditUserModal('${u.id}')"
            title="Edit ${escapeJs(u.fullName || 'User')}'s profile"
            class="px-2 py-1 rounded-md text-2xs font-bold bg-stone-50 hover:bg-stone-100 text-slate-700 border border-slate-300 transition flex items-center gap-1 cursor-pointer">
            <svg class="w-3 h-3 text-slate-500"><use href="#icon-edit" /></svg>
            Edit
          </button>
          <button type="button" onclick="openAssignVolunteerModal(null, '${u.id}', '${escapeJs(u.fullName || u.email)}')"
            title="Assign shift to this volunteer"
            class="px-2 py-1 rounded-md text-2xs font-bold bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 transition cursor-pointer">
            + Assign Shift
          </button>
          ${!isSelf ? `
            <button type="button" onclick="openToggleDisableModal('${u.id}', '${escapeJs(u.fullName || u.email)}', ${Boolean(u.disabled)})"
              title="${u.disabled ? 'Re-activate account' : 'Deactivate account'}"
              class="px-2 py-1 rounded-md text-2xs font-bold transition border cursor-pointer ${u.disabled ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-stone-50 hover:bg-stone-100 text-slate-700 border-slate-300'}">
              ${u.disabled ? 'Enable' : 'Disable'}
            </button>
            <button type="button" onclick="openDeleteBlockModal('${u.id}', '${escapeJs(u.fullName || u.email)}', '${escapeJs(u.email || '')}')"
              title="Permanently delete account, release shifts, and block email"
              class="px-2 py-1 rounded-md text-2xs font-bold bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-300 transition cursor-pointer">
              Delete &amp; Block
            </button>
          ` : ''}
        </div>
      </td>
    `;
    tableBody.appendChild(tr);
  });

  // 2. Render Mobile Cards
  cardsContainer.innerHTML = "";
  pageUsers.forEach((u) => {
    const card = document.createElement("div");
    card.className = `p-3 rounded-xl border ${u.disabled ? 'border-rose-200 bg-rose-50/20' : 'border-amber-200 bg-white'} shadow-2xs space-y-2.5`;

    const isSelf = currentAdminUser && u.id === currentAdminUser.uid;
    const role = u.role || "volunteer";
    const shiftsCount = getVolunteerShiftCount(u.id);

    card.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <button type="button" onclick="openAdminEditUserModal('${u.id}')"
          title="Click to view & edit ${escapeJs(u.fullName || 'User')}'s profile"
          class="group/user flex items-center space-x-2 text-left cursor-pointer focus:outline-none focus:ring-2 focus:ring-amber-500 rounded-lg p-1 -m-1 hover:bg-amber-100/60 transition min-w-0">
          ${u.photoURL ? `
            <img src="${escapeHtml(u.photoURL)}" class="w-8 h-8 rounded-full object-cover shrink-0 border border-amber-300 group-hover/user:ring-2 group-hover/user:ring-amber-500 transition" alt="Avatar" />
          ` : `
            <div class="w-8 h-8 rounded-full bg-amber-200 text-amber-900 font-bold flex items-center justify-center text-xs shrink-0 border border-amber-300 group-hover/user:ring-2 group-hover/user:ring-amber-500 transition">
              ${escapeHtml((u.fullName || u.email || "U")[0].toUpperCase())}
            </div>
          `}
          <div class="min-w-0">
            <p class="font-bold text-slate-800 text-xs truncate flex items-center gap-1 group-hover/user:text-amber-900 group-hover/user:underline">
              <span class="truncate">${escapeHtml(u.fullName || "Volunteer")}</span>
              <svg class="w-3 h-3 text-slate-400 group-hover/user:text-amber-700 opacity-60 group-hover/user:opacity-100 transition shrink-0"><use href="#icon-edit" /></svg>
              ${isSelf ? '<span class="text-2xs text-amber-800 font-bold bg-amber-100 px-1 py-0.2 rounded shrink-0 no-underline">(You)</span>' : ''}
            </p>
            <p class="text-2xs text-slate-500 font-mono truncate">${escapeHtml(u.email || "No email")}</p>
          </div>
        </button>
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="px-2 py-0.5 rounded-full text-2xs font-bold ${u.disabled ? 'bg-rose-100 text-rose-800 border border-rose-300' : 'bg-emerald-50 text-emerald-800 border border-emerald-300'}">
            ${u.disabled ? 'Disabled' : 'Active'}
          </span>
          <span class="px-2 py-0.5 rounded-full text-2xs font-bold tabular-nums bg-amber-100 text-amber-900 border border-amber-300">
            ${shiftsCount} shift${shiftsCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div class="flex items-center justify-between text-2xs text-slate-600 border-t border-slate-100 pt-2">
        <span>Phone: <strong class="font-mono text-slate-800">${escapeHtml(u.phoneNumber || '—')}</strong></span>
        <span class="flex items-center gap-1">Group: ${renderUserGroupBadge(u)}</span>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-1.5 border-t border-slate-100 pt-2">
        <div class="flex items-center gap-1">
          <label class="text-2xs text-slate-500">Role:</label>
          ${isSelf ? `
            <span class="text-2xs font-bold text-slate-700 uppercase">${role}</span>
          ` : `
            <select onchange="handleRoleChange('${u.id}', this.value, '${escapeJs(u.fullName || u.email)}', this)"
              class="text-xs p-1 rounded-md border border-slate-300 bg-white font-semibold min-h-[36px]">
              <option value="volunteer" ${role === 'volunteer' ? 'selected' : ''}>Volunteer</option>
              <option value="manager" ${role === 'manager' ? 'selected' : ''}>Manager</option>
              <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
            </select>
          `}
        </div>

        <div class="flex items-center gap-1">
          <button type="button" onclick="openAdminEditUserModal('${u.id}')"
            class="px-2 py-1.5 rounded-lg text-xs font-semibold bg-stone-50 hover:bg-stone-100 text-slate-700 border border-slate-300 min-h-[36px] flex items-center gap-1 cursor-pointer">
            <svg class="w-3 h-3 text-slate-500"><use href="#icon-edit" /></svg>
            Edit
          </button>
          <button type="button" onclick="openAssignVolunteerModal(null, '${u.id}', '${escapeJs(u.fullName || u.email)}')"
            class="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-amber-700 hover:bg-amber-800 text-white min-h-[36px] shadow-2xs cursor-pointer">
            + Assign
          </button>
          ${!isSelf ? `
            <button type="button" onclick="openToggleDisableModal('${u.id}', '${escapeJs(u.fullName || u.email)}', ${Boolean(u.disabled)})"
              class="px-2 py-1.5 rounded-lg text-xs font-semibold border min-h-[36px] cursor-pointer ${u.disabled ? 'bg-emerald-50 text-emerald-800 border-emerald-300' : 'bg-stone-50 text-slate-700 border-slate-300'}">
              ${u.disabled ? 'Enable' : 'Disable'}
            </button>
            <button type="button" onclick="openDeleteBlockModal('${u.id}', '${escapeJs(u.fullName || u.email)}', '${escapeJs(u.email || '')}')"
              class="px-2 py-1.5 rounded-lg text-xs font-bold bg-rose-50 text-rose-800 border border-rose-300 min-h-[36px] cursor-pointer">
              Delete
            </button>
          ` : ''}
        </div>
      </div>
    `;
    cardsContainer.appendChild(card);
  });
}

async function handleRoleChange(targetUserId, newRole, userName, selectEl) {
  if (!confirm(`Are you sure you want to change the role of "${userName}" to ${newRole.toUpperCase()}?`)) {
    renderCrewDirectory();
    return;
  }

  if (selectEl) selectEl.disabled = true;
  try {
    const fn = functions.httpsCallable("updateUserRole");
    await fn({ targetUserId, newRole });
  } catch (err) {
    alert("Role update failed: " + err.message);
    renderCrewDirectory();
  }
}

// ============================================================================
// GROUP MANAGEMENT (filter, badges, Manage Groups modal, Set Group modal)
// ============================================================================
const GROUP_BADGE_PALETTE = [
  "bg-amber-100 text-amber-900 border-amber-300",
  "bg-teal-50 text-teal-800 border-teal-300",
  "bg-sky-50 text-sky-800 border-sky-300",
  "bg-violet-50 text-violet-800 border-violet-300",
  "bg-rose-50 text-rose-800 border-rose-300",
  "bg-lime-50 text-lime-800 border-lime-300",
  "bg-orange-50 text-orange-800 border-orange-300",
  "bg-indigo-50 text-indigo-800 border-indigo-300"
];

function groupNameKey(name) {
  return (name || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function findGroupByNameKey(key) {
  if (!key) return null;
  for (const g of allGroupsMap.values()) {
    if ((g.nameKey || groupNameKey(g.name)) === key) return g;
  }
  return null;
}

/**
 * Resolves a user's group. Prefers the server-linked groupId; falls back to
 * matching legacy free-text groupOrClub by normalised name (lazy migration).
 * @return {{id: string|null, name: string, linked: boolean}}
 */
function resolveUserGroup(u) {
  if (u.groupId && allGroupsMap.has(u.groupId)) {
    return { id: u.groupId, name: allGroupsMap.get(u.groupId).name, linked: true };
  }
  const raw = (u.groupOrClub || "").trim();
  if (!raw) return { id: null, name: "", linked: false };
  const match = findGroupByNameKey(groupNameKey(raw));
  if (match) return { id: match.id, name: match.name, linked: false };
  return { id: null, name: raw, linked: false };
}

function getGroupBadgeClass(groupId) {
  let hash = 0;
  for (let i = 0; i < groupId.length; i++) hash = (hash * 31 + groupId.charCodeAt(i)) >>> 0;
  return GROUP_BADGE_PALETTE[hash % GROUP_BADGE_PALETTE.length];
}

function getGroupMemberCounts() {
  const counts = new Map();
  let none = 0;
  allUsersMap.forEach((u) => {
    const gid = resolveUserGroup(u).id;
    if (gid) counts.set(gid, (counts.get(gid) || 0) + 1);
    else none++;
  });
  return { counts, none };
}

function renderUserGroupBadge(u) {
  const g = resolveUserGroup(u);
  const userName = escapeHtml(u.fullName || u.email || "User");
  const onclick = `openSetUserGroupModal('${escapeHtml(u.id)}', this.dataset.userName)`;
  if (g.id) {
    return `<button type="button" data-user-name="${userName}" onclick="${onclick}" title="Change group" aria-label="Change group for ${userName} (currently ${escapeHtml(g.name)})"
      class="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-bold border transition hover:brightness-95 hover:shadow-2xs min-h-[24px] ${getGroupBadgeClass(g.id)}">
      ${escapeHtml(g.name)}</button>`;
  }
  if (g.name) {
    return `<button type="button" data-user-name="${userName}" onclick="${onclick}" title="Not linked to a managed group yet. Click to assign." aria-label="Assign group to ${userName} (currently unlinked club ${escapeHtml(g.name)})"
      class="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-semibold italic border border-dashed border-slate-300 bg-slate-50 text-slate-600 hover:bg-slate-100 transition min-h-[24px]">
      ${escapeHtml(g.name)}</button>`;
  }
  return `<button type="button" data-user-name="${userName}" onclick="${onclick}" title="Assign a group" aria-label="Assign group to ${userName}"
    class="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-semibold border border-dashed border-slate-300 text-slate-500 hover:text-amber-800 hover:border-amber-400 transition min-h-[24px]">
    + Group</button>`;
}

function renderGroupFilterOptions() {
  const select = document.getElementById("crew-group-filter");
  if (!select) return;
  const { counts, none } = getGroupMemberCounts();
  select.innerHTML = "";
  select.appendChild(new Option(`All groups (${allUsersMap.size})`, "ALL"));
  select.appendChild(new Option(`No group (${none})`, "NONE"));
  allGroupsMap.forEach((g) => {
    select.appendChild(new Option(`${g.name} (${counts.get(g.id) || 0})`, g.id));
  });
  select.value = crewGroupFilter;
}

function setCrewGroupFilter(val) {
  crewGroupFilter = val || "ALL";
  crewCurrentPage = 1;
  renderCrewDirectory();
}

function showManageGroupsAlert(message, isError) {
  const el = document.getElementById("manage-groups-alert");
  if (!el) return;
  if (!message) {
    el.className = "hidden p-3 rounded-lg text-xs";
    el.textContent = "";
    return;
  }
  el.className = isError ?
    "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300" :
    "p-3 rounded-lg text-xs bg-emerald-50 text-emerald-800 border border-emerald-300";
  el.textContent = message;
}

function openManageGroupsModal() {
  editingGroupId = null;
  showManageGroupsAlert("");
  renderManageGroupsList();
  const modal = document.getElementById("modal-manage-groups");
  if (modal) modal.classList.remove("hidden");
  document.getElementById("new-group-name")?.focus();
}

function closeManageGroupsModal() {
  editingGroupId = null;
  const modal = document.getElementById("modal-manage-groups");
  if (modal) modal.classList.add("hidden");
}

function getUnlinkedGroupNames() {
  // Distinct legacy free-text names that match no managed group
  const map = new Map();
  allUsersMap.forEach((u) => {
    const g = resolveUserGroup(u);
    if (!g.id && g.name) {
      const key = groupNameKey(g.name);
      const entry = map.get(key) || { name: g.name, count: 0 };
      entry.count++;
      map.set(key, entry);
    }
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function renderManageGroupsList() {
  const list = document.getElementById("manage-groups-list");
  const countEl = document.getElementById("manage-groups-count");
  if (!list) return;

  const { counts } = getGroupMemberCounts();
  const groups = Array.from(allGroupsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  if (countEl) countEl.textContent = `${groups.length} group${groups.length === 1 ? "" : "s"}`;

  let html = "";
  if (groups.length === 0) {
    html += `<div class="p-6 text-center text-slate-400 italic text-xs">No groups yet. Add one above, or they'll appear as volunteers sign up.</div>`;
  }

  groups.forEach((g) => {
    const members = counts.get(g.id) || 0;
    const included = g.includeInGroupIncentives !== false;
    const canMerge = groups.length > 1;

    const nameBlock = editingGroupId === g.id ? `
      <form onsubmit="handleRenameGroup(event, '${g.id}')" class="flex items-center gap-1.5 flex-grow">
        <input type="text" id="rename-group-input-${g.id}" value="${escapeHtml(g.name)}" maxlength="50" minlength="2" required
          aria-label="Group name"
          class="flex-grow text-xs px-2.5 py-1.5 rounded-lg border border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-500 font-semibold" />
        <button type="submit" class="px-2.5 py-1.5 rounded-lg text-2xs font-bold bg-amber-700 hover:bg-amber-800 text-white min-h-[32px]">Save</button>
        <button type="button" onclick="setEditingGroup(null)" class="px-2.5 py-1.5 rounded-lg text-2xs font-semibold text-slate-600 hover:bg-slate-100 min-h-[32px]">Cancel</button>
      </form>` : `
      <div class="min-w-0 flex-grow">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${getGroupBadgeClass(g.id)}">${escapeHtml(g.name)}</span>
          <span class="inline-flex items-center gap-1 text-2xs font-semibold px-2 py-0.5 rounded-full border ${included ? 'text-amber-900 bg-amber-50 border-amber-200' : 'text-slate-500 bg-slate-100 border-slate-200'}">
            <span class="w-1.5 h-1.5 rounded-full ${included ? 'bg-amber-600' : 'bg-slate-400'}"></span>
            ${included ? 'Incentives Active' : 'Excluded from Incentives'}
          </span>
        </div>
        <p class="text-2xs text-slate-500 mt-1 tabular-nums font-medium">${members} volunteer${members === 1 ? "" : "s"}${g.createdBy === "signup" ? " &middot; registered via volunteer signup" : ""}</p>
      </div>`;

    html += `
      <div class="py-3 px-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-amber-50/30 transition rounded-lg">
        ${nameBlock}
        ${editingGroupId === g.id ? "" : `
        <div class="flex items-center gap-1.5 flex-wrap sm:justify-end shrink-0">
          <button type="button" onclick="setEditingGroup('${g.id}')" title="Rename ${escapeHtml(g.name)}"
            class="px-2.5 py-1.5 rounded-lg text-2xs font-semibold text-slate-600 hover:text-amber-900 hover:bg-amber-100/60 border border-slate-200 transition flex items-center gap-1 min-h-[32px]" aria-label="Rename ${escapeHtml(g.name)}">
            <svg class="w-3.5 h-3.5 text-slate-500"><use href="#icon-edit" /></svg>
            <span>Rename</span>
          </button>
          ${canMerge ? `
          <button type="button" onclick="openMergeGroupModal('${g.id}')" title="Merge ${escapeHtml(g.name)} into another group"
            class="px-2.5 py-1.5 rounded-lg text-2xs font-semibold text-slate-600 hover:text-amber-900 hover:bg-amber-100/60 border border-slate-200 transition flex items-center gap-1 min-h-[32px]" aria-label="Merge ${escapeHtml(g.name)} into another group">
            <svg class="w-3.5 h-3.5 text-slate-500"><use href="#icon-users" /></svg>
            <span>Merge&hellip;</span>
          </button>` : ""}
          <button type="button" onclick="handleToggleGroupIncentives('${g.id}', ${!included}, this)"
            title="${included ? 'Exclude ' + escapeHtml(g.name) + ' from Group Incentives' : 'Include ' + escapeHtml(g.name) + ' in Group Incentives'}"
            aria-label="${included ? 'Exclude ' + escapeHtml(g.name) + ' from Group Incentives' : 'Include ' + escapeHtml(g.name) + ' in Group Incentives'}"
            class="px-2.5 py-1.5 rounded-lg text-2xs font-semibold border transition flex items-center gap-1.5 min-h-[32px] ${included ? 'bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-100' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'}">
            ${included ? '<svg class="w-3.5 h-3.5 text-amber-700"><use href="#icon-check" /></svg><span>Incentives: ON</span>' : '<span class="w-2 h-2 rounded-full bg-slate-400"></span><span>Incentives: OFF</span>'}
          </button>
          <button type="button" onclick="openDeleteGroupModal('${g.id}')" title="Delete ${escapeHtml(g.name)}"
            class="px-2.5 py-1.5 rounded-lg text-2xs font-semibold text-rose-700 hover:bg-rose-50 border border-rose-200 transition flex items-center gap-1 min-h-[32px]" aria-label="Delete ${escapeHtml(g.name)}">
            <svg class="w-3.5 h-3.5 text-rose-600"><use href="#icon-trash" /></svg>
            <span>Delete</span>
          </button>
        </div>`}
      </div>`;
  });

  const unlinked = getUnlinkedGroupNames();
  if (unlinked.length > 0) {
    html += `
      <div class="py-3 px-2 bg-slate-50/80 rounded-lg mt-2">
        <p class="text-2xs font-bold text-slate-600 uppercase tracking-wider mb-1 flex items-center gap-1">
          <svg class="w-3.5 h-3.5 text-amber-700"><use href="#icon-info" /></svg>
          Clubs from Volunteer Signups (Pending Setup)
        </p>
        <p class="text-2xs text-slate-500 mb-2">Volunteers entered these club names during registration. Click a club to promote it to an official managed group:</p>
        <div class="flex flex-wrap gap-1.5">
          ${unlinked.map((u) => `
            <button type="button" data-group-name="${escapeHtml(u.name)}" onclick="handleCreateGroupFromName(this.dataset.groupName)" title="Create a managed group with this name"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-2xs font-semibold italic border border-dashed border-slate-300 bg-white text-slate-700 hover:border-amber-400 hover:text-amber-900 transition min-h-[28px] shadow-2xs">
              + ${escapeHtml(u.name)} <span class="not-italic text-slate-400 tabular-nums">(${u.count})</span>
            </button>`).join("")}
        </div>
      </div>`;
  }

  list.innerHTML = html;

  if (editingGroupId) {
    const input = document.getElementById(`rename-group-input-${editingGroupId}`);
    if (input) { input.focus(); input.select(); }
  }
}

function setEditingGroup(groupId) {
  editingGroupId = groupId;
  renderManageGroupsList();
}

async function callGroupFunction(name, payload, successMessage) {
  showManageGroupsAlert("");
  try {
    const fn = functions.httpsCallable(name);
    const res = await fn(payload);
    if (successMessage) showManageGroupsAlert(successMessage(res.data || {}), false);
    return res.data;
  } catch (err) {
    showManageGroupsAlert(err.message || "Request failed.", true);
    throw err;
  }
}

async function handleCreateGroup(e) {
  e.preventDefault();
  const input = document.getElementById("new-group-name");
  const btn = document.getElementById("btn-create-group");
  const name = (input?.value || "").trim();
  if (!name) return;
  if (btn) btn.disabled = true;
  try {
    await callGroupFunction("createGroup", { name }, (d) => `Group "${d.name}" created.`);
    if (input) input.value = "";
  } catch (_) {
    // alert already shown
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleCreateGroupFromName(name) {
  try {
    await callGroupFunction("createGroup", { name },
      (d) => `Group "${d.name}" created. Matching profiles are now grouped under it.`);
  } catch (_) { /* alert shown */ }
}

async function handleRenameGroup(e, groupId) {
  e.preventDefault();
  const input = document.getElementById(`rename-group-input-${groupId}`);
  const name = (input?.value || "").trim();
  const current = allGroupsMap.get(groupId);
  if (!name || !current) return;
  if (name === current.name) { setEditingGroup(null); return; }
  if (input) input.disabled = true;
  try {
    await callGroupFunction("updateGroup", { groupId, name },
      (d) => `Renamed to "${d.name}" (${d.updatedUsers} user${d.updatedUsers === 1 ? "" : "s"} updated).`);
    editingGroupId = null;
    renderManageGroupsList();
  } catch (_) {
    if (input) input.disabled = false;
  }
}

async function handleToggleGroupIncentives(groupId, include, buttonEl) {
  if (buttonEl) buttonEl.disabled = true;
  try {
    await callGroupFunction("updateGroup", { groupId, includeInGroupIncentives: include },
      (d) => `"${d.name}" ${d.includeInGroupIncentives ? "included in" : "excluded from"} Group Incentives.`);
  } catch (_) {
    // alert handled by callGroupFunction
  } finally {
    if (buttonEl) buttonEl.disabled = false;
  }
}

function openMergeGroupModal(sourceGroupId) {
  const source = allGroupsMap.get(sourceGroupId);
  if (!source) return;
  const modal = document.getElementById("modal-merge-group");
  const sourceIdInput = document.getElementById("merge-group-source-id");
  const sourceNameEl = document.getElementById("merge-group-source-name");
  const deleteNoteEl = document.getElementById("merge-group-source-delete-note");
  const membersCountEl = document.getElementById("merge-group-members-count");
  const targetSelect = document.getElementById("merge-group-target-select");
  const alertEl = document.getElementById("merge-group-alert");

  if (alertEl) alertEl.className = "hidden p-3 rounded-lg text-xs";
  if (sourceIdInput) sourceIdInput.value = sourceGroupId;
  if (sourceNameEl) sourceNameEl.textContent = `"${source.name}"`;
  if (deleteNoteEl) deleteNoteEl.textContent = `"${source.name}"`;

  const members = getGroupMemberCounts().counts.get(sourceGroupId) || 0;
  if (membersCountEl) {
    membersCountEl.textContent = `${members} volunteer${members === 1 ? "" : "s"}`;
  }

  if (targetSelect) {
    targetSelect.innerHTML = "";
    const otherGroups = Array.from(allGroupsMap.values())
      .filter((g) => g.id !== sourceGroupId)
      .sort((a, b) => a.name.localeCompare(b.name));
    otherGroups.forEach((g) => {
      targetSelect.appendChild(new Option(g.name, g.id));
    });
  }

  if (modal) modal.classList.remove("hidden");
  targetSelect?.focus();
}

function closeMergeGroupModal() {
  const modal = document.getElementById("modal-merge-group");
  if (modal) modal.classList.add("hidden");
}

async function handleMergeGroupSubmit(e) {
  e.preventDefault();
  const sourceGroupId = document.getElementById("merge-group-source-id")?.value;
  const targetGroupId = document.getElementById("merge-group-target-select")?.value;
  const btn = document.getElementById("btn-submit-merge-group");
  const alertEl = document.getElementById("merge-group-alert");

  if (!sourceGroupId || !targetGroupId) return;
  if (btn) btn.disabled = true;

  try {
    const res = await callGroupFunction("mergeGroups", { sourceGroupId, targetGroupId });
    closeMergeGroupModal();
    showManageGroupsAlert(`Merged into "${res.targetName}" (${res.movedUsers} user${res.movedUsers === 1 ? "" : "s"} moved).`, false);
  } catch (err) {
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300";
      alertEl.textContent = "Error: " + err.message;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openDeleteGroupModal(groupId) {
  const group = allGroupsMap.get(groupId);
  if (!group) return;
  const modal = document.getElementById("modal-delete-group");
  const idInput = document.getElementById("delete-group-id");
  const nameEl = document.getElementById("delete-group-name");
  const membersCountEl = document.getElementById("delete-group-members-count");
  const alertEl = document.getElementById("delete-group-alert");

  if (alertEl) alertEl.className = "hidden p-3 rounded-lg text-xs";
  if (idInput) idInput.value = groupId;
  if (nameEl) nameEl.textContent = `"${group.name}"`;

  const members = getGroupMemberCounts().counts.get(groupId) || 0;
  if (membersCountEl) {
    membersCountEl.textContent = `${members} volunteer${members === 1 ? "" : "s"}`;
  }

  if (modal) modal.classList.remove("hidden");
}

function closeDeleteGroupModal() {
  const modal = document.getElementById("modal-delete-group");
  if (modal) modal.classList.add("hidden");
}

async function handleDeleteGroupSubmit(e) {
  e.preventDefault();
  const groupId = document.getElementById("delete-group-id")?.value;
  const btn = document.getElementById("btn-submit-delete-group");
  const alertEl = document.getElementById("delete-group-alert");

  if (!groupId) return;
  if (btn) btn.disabled = true;

  try {
    const res = await callGroupFunction("deleteGroup", { groupId });
    closeDeleteGroupModal();
    showManageGroupsAlert(`Group deleted (${res.affectedUsers} user${res.affectedUsers === 1 ? "" : "s"} now have no group).`, false);
  } catch (err) {
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300";
      alertEl.textContent = "Error: " + err.message;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openSetUserGroupModal(userId, userName) {
  const u = allUsersMap.get(userId);
  if (!u) return;
  const modal = document.getElementById("modal-set-user-group");
  const select = document.getElementById("set-user-group-select");
  const nameEl = document.getElementById("set-user-group-name");
  const uidInput = document.getElementById("set-user-group-uid");
  const legacyEl = document.getElementById("set-user-group-legacy");
  const alertEl = document.getElementById("set-user-group-alert");

  if (alertEl) alertEl.className = "hidden p-3 rounded-lg text-xs";
  if (nameEl) nameEl.textContent = userName;
  if (uidInput) uidInput.value = userId;

  const g = resolveUserGroup(u);
  if (select) {
    select.innerHTML = "";
    select.appendChild(new Option("No group", ""));
    allGroupsMap.forEach((grp) => select.appendChild(new Option(grp.name, grp.id)));
    select.value = g.id || "";
  }
  if (legacyEl) {
    if (!g.id && g.name) {
      legacyEl.textContent = `Current free-text value "${g.name}" isn't a managed group. Pick a group, or create "${g.name}" in Manage Groups.`;
      legacyEl.classList.remove("hidden");
    } else {
      legacyEl.classList.add("hidden");
    }
  }
  if (modal) modal.classList.remove("hidden");
}

function closeSetUserGroupModal() {
  const modal = document.getElementById("modal-set-user-group");
  if (modal) modal.classList.add("hidden");
}

async function handleSetUserGroupSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById("set-user-group-uid")?.value;
  const groupId = document.getElementById("set-user-group-select")?.value || null;
  const btn = document.getElementById("btn-submit-set-user-group");
  const alertEl = document.getElementById("set-user-group-alert");
  if (!userId) return;
  if (btn) btn.disabled = true;
  try {
    const fn = functions.httpsCallable("setUserGroup");
    await fn({ targetUserId: userId, groupId });
    closeSetUserGroupModal();
  } catch (err) {
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300";
      alertEl.textContent = "Error: " + err.message;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ============================================================================
// MODAL: ADMIN EDIT USER PROFILE
// ============================================================================
let editingProfileUserId = null;

function openAdminEditUserModal(userId) {
  const u = allUsersMap.get(userId);
  if (!u) {
    console.warn("User not found in allUsersMap:", userId);
    return;
  }

  editingProfileUserId = userId;
  const modal = document.getElementById("modal-admin-edit-user");
  const alertEl = document.getElementById("admin-edit-user-alert");
  if (!modal) return;

  if (alertEl) {
    alertEl.className = "hidden p-3 rounded-lg text-xs";
    alertEl.textContent = "";
  }

  const role = u.role || "volunteer";
  const roleBadgeEl = document.getElementById("admin-edit-user-badge-role");
  if (roleBadgeEl) {
    roleBadgeEl.textContent = role.toUpperCase();
    roleBadgeEl.className = `px-2 py-0.5 rounded-full text-2xs font-bold uppercase tracking-wider ${
      role === "admin" ? "bg-purple-100 text-purple-900 border border-purple-300" :
      role === "manager" ? "bg-blue-100 text-blue-900 border border-blue-300" :
      "bg-amber-100 text-amber-900 border border-amber-300"
    }`;
  }

  // Summary Card
  const avatarPreview = document.getElementById("admin-edit-user-avatar-preview");
  if (avatarPreview) {
    if (u.photoURL) {
      avatarPreview.innerHTML = `<img src="${escapeHtml(u.photoURL)}" class="w-full h-full object-cover" alt="Avatar" />`;
    } else {
      const initial = (u.fullName || u.email || "U")[0].toUpperCase();
      avatarPreview.innerHTML = `<span>${escapeHtml(initial)}</span>`;
    }
  }

  const cardName = document.getElementById("admin-edit-user-card-name");
  if (cardName) cardName.textContent = u.fullName || u.email || "Volunteer";

  const cardUid = document.getElementById("admin-edit-user-card-uid");
  if (cardUid) cardUid.textContent = `UID: ${u.id}`;

  const cardStatus = document.getElementById("admin-edit-user-card-status");
  if (cardStatus) {
    cardStatus.textContent = u.disabled ? "Disabled" : "Active";
    cardStatus.className = `px-2 py-0.5 rounded-full text-2xs font-bold ${
      u.disabled ? "bg-rose-100 text-rose-800 border border-rose-300" : "bg-emerald-50 text-emerald-800 border border-emerald-300"
    }`;
  }

  const shiftsCount = getVolunteerShiftCount(u.id);
  const cardShifts = document.getElementById("admin-edit-user-card-shifts");
  if (cardShifts) cardShifts.textContent = `${shiftsCount} shift${shiftsCount === 1 ? "" : "s"} allocated`;

  // Form Fields
  const uidInput = document.getElementById("admin-edit-user-uid");
  if (uidInput) uidInput.value = u.id;

  const nameInput = document.getElementById("admin-edit-user-fullname");
  if (nameInput) nameInput.value = u.fullName || "";

  const emailInput = document.getElementById("admin-edit-user-email");
  if (emailInput) emailInput.value = u.email || "";

  const phoneInput = document.getElementById("admin-edit-user-phone");
  if (phoneInput) phoneInput.value = u.phoneNumber || "";

  // Group Select
  const groupSelect = document.getElementById("admin-edit-user-group-select");
  const customGroupContainer = document.getElementById("admin-edit-user-custom-group-container");
  const customGroupInput = document.getElementById("admin-edit-user-custom-group");

  const resolvedGroup = resolveUserGroup(u);
  if (groupSelect) {
    groupSelect.innerHTML = "";
    groupSelect.appendChild(new Option("No group", ""));
    allGroupsMap.forEach((grp) => {
      groupSelect.appendChild(new Option(grp.name, grp.id));
    });
    groupSelect.appendChild(new Option("Custom / Other...", "__CUSTOM__"));

    if (resolvedGroup.id && allGroupsMap.has(resolvedGroup.id)) {
      groupSelect.value = resolvedGroup.id;
      if (customGroupContainer) customGroupContainer.classList.add("hidden");
      if (customGroupInput) customGroupInput.value = "";
    } else if (resolvedGroup.name) {
      groupSelect.value = "__CUSTOM__";
      if (customGroupContainer) customGroupContainer.classList.remove("hidden");
      if (customGroupInput) customGroupInput.value = resolvedGroup.name;
    } else {
      groupSelect.value = "";
      if (customGroupContainer) customGroupContainer.classList.add("hidden");
      if (customGroupInput) customGroupInput.value = "";
    }
  }

  // Visibility
  const visSelect = document.getElementById("admin-edit-user-visibility");
  if (visSelect) visSelect.value = u.profileVisibility === "private" ? "private" : "public";

  // Notifications
  const waCb = document.getElementById("admin-edit-user-notif-whatsapp");
  if (waCb) waCb.checked = u.whatsappNotifications !== false;

  const emailCb = document.getElementById("admin-edit-user-notif-email");
  if (emailCb) emailCb.checked = u.emailNotifications !== false;

  // Reset Submit Button State
  const submitBtn = document.getElementById("btn-submit-admin-edit-user");
  const submitText = document.getElementById("btn-submit-admin-edit-user-text");
  if (submitBtn) submitBtn.disabled = false;
  if (submitText) submitText.textContent = "Save Changes";

  modal.classList.remove("hidden");
}

function closeAdminEditUserModal() {
  editingProfileUserId = null;
  const modal = document.getElementById("modal-admin-edit-user");
  if (modal) modal.classList.add("hidden");
}

function handleAdminEditUserGroupSelect(val) {
  const customContainer = document.getElementById("admin-edit-user-custom-group-container");
  const customInput = document.getElementById("admin-edit-user-custom-group");
  if (val === "__CUSTOM__") {
    if (customContainer) customContainer.classList.remove("hidden");
    if (customInput) customInput.focus();
  } else {
    if (customContainer) customContainer.classList.add("hidden");
  }
}

async function handleAdminEditUserSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById("admin-edit-user-uid")?.value || editingProfileUserId;
  if (!userId) return;

  const fullName = document.getElementById("admin-edit-user-fullname")?.value?.trim();
  const email = document.getElementById("admin-edit-user-email")?.value?.trim()?.toLowerCase();
  const phoneNumber = document.getElementById("admin-edit-user-phone")?.value?.trim();
  const groupSelectVal = document.getElementById("admin-edit-user-group-select")?.value;
  const customGroupVal = document.getElementById("admin-edit-user-custom-group")?.value?.trim();
  const profileVisibility = document.getElementById("admin-edit-user-visibility")?.value || "public";
  const whatsappNotifications = Boolean(document.getElementById("admin-edit-user-notif-whatsapp")?.checked);
  const emailNotifications = Boolean(document.getElementById("admin-edit-user-notif-email")?.checked);

  const alertEl = document.getElementById("admin-edit-user-alert");
  const submitBtn = document.getElementById("btn-submit-admin-edit-user");
  const submitText = document.getElementById("btn-submit-admin-edit-user-text");

  if (!fullName) {
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-200 block";
      alertEl.textContent = "Full name cannot be empty.";
    }
    return;
  }

  if (!email) {
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-200 block";
      alertEl.textContent = "Email address cannot be empty.";
    }
    return;
  }

  // Resolve group
  let groupId = null;
  let groupOrClub = "";
  if (groupSelectVal === "__CUSTOM__") {
    groupOrClub = customGroupVal || "";
    groupId = null;
  } else if (groupSelectVal) {
    groupId = groupSelectVal;
    groupOrClub = allGroupsMap.get(groupSelectVal)?.name || "";
  } else {
    groupId = null;
    groupOrClub = "";
  }

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Saving...";

  try {
    // 1. Attempt Cloud Function adminUpdateUserProfile
    try {
      const updateFn = functions.httpsCallable("adminUpdateUserProfile");
      await updateFn({
        targetUserId: userId,
        fullName,
        email,
        phoneNumber,
        groupId,
        groupOrClub,
        profileVisibility,
        whatsappNotifications,
        emailNotifications,
      });
    } catch (fnErr) {
      console.warn("adminUpdateUserProfile callable returned error, attempting direct Firestore fallback if appropriate:", fnErr);
      if (fnErr.code === "functions/not-found" || fnErr.message?.includes("not found")) {
        // Fallback directly to Firestore update for local dev
        await db.collection("users").doc(userId).update({
          fullName,
          email,
          phoneNumber: phoneNumber || "",
          groupId: groupId || null,
          groupOrClub: groupOrClub || "",
          profileVisibility,
          whatsappNotifications,
          emailNotifications,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedBy: currentAdminUser.uid,
        });
      } else {
        throw fnErr;
      }
    }

    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 block";
      alertEl.textContent = `Profile for ${fullName} updated successfully!`;
    }

    // Update in-memory user map immediately for fast UI feedback
    const existingUser = allUsersMap.get(userId) || {};
    allUsersMap.set(userId, {
      ...existingUser,
      id: userId,
      fullName,
      email,
      phoneNumber,
      groupId,
      groupOrClub,
      profileVisibility,
      whatsappNotifications,
      emailNotifications,
    });

    renderCrewDirectory();
    if (typeof activeRosterShiftId !== "undefined" && activeRosterShiftId) {
      renderRosterModalContent(activeRosterShiftId);
    }

    setTimeout(() => {
      closeAdminEditUserModal();
    }, 800);
  } catch (err) {
    console.error("Failed to update user profile:", err);
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-200 block";
      alertEl.textContent = err.message || "Failed to update profile. Please verify your permissions and input.";
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = "Save Changes";
  }
}

// ============================================================================
// MODAL: DISABLE / RE-ENABLE ACCOUNT
// ============================================================================
function openToggleDisableModal(userId, userName, currentDisabled) {
  const modal = document.getElementById("modal-toggle-disable");
  const titleEl = document.getElementById("toggle-disable-title");
  const promptEl = document.getElementById("toggle-disable-prompt");
  const targetUidInput = document.getElementById("disable-target-uid");
  const targetActionInput = document.getElementById("disable-target-action");
  const reasonWrap = document.getElementById("disable-reason-wrap");
  const alertEl = document.getElementById("toggle-disable-alert");

  if (alertEl) alertEl.classList.add("hidden");
  if (targetUidInput) targetUidInput.value = userId;

  const nextState = !currentDisabled;
  if (targetActionInput) targetActionInput.value = nextState ? "disable" : "enable";

  if (nextState) {
    if (titleEl) titleEl.innerHTML = `<svg class="w-4 h-4 text-amber-700"><use href="#icon-user-x" /></svg> Deactivate Account`;
    if (promptEl) promptEl.textContent = `Are you sure you want to deactivate the account for "${userName}"? They will be immediately signed out and unable to log in.`;
    if (reasonWrap) reasonWrap.classList.remove("hidden");
  } else {
    if (titleEl) titleEl.innerHTML = `<svg class="w-4 h-4 text-emerald-700"><use href="#icon-user-check" /></svg> Reactivate Account`;
    if (promptEl) promptEl.textContent = `Are you sure you want to reactivate the account for "${userName}"? They will regain access to register for shifts.`;
    if (reasonWrap) reasonWrap.classList.add("hidden");
  }

  if (modal) modal.classList.remove("hidden");
}

function closeToggleDisableModal() {
  const modal = document.getElementById("modal-toggle-disable");
  if (modal) modal.classList.add("hidden");
}

async function handleToggleDisableSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById("disable-target-uid")?.value;
  const action = document.getElementById("disable-target-action")?.value;
  const reason = document.getElementById("disable-reason-input")?.value?.trim() || "";
  const alertEl = document.getElementById("toggle-disable-alert");
  const submitBtn = document.getElementById("btn-submit-disable");

  if (!userId) return;

  if (submitBtn) submitBtn.disabled = true;
  try {
    const fn = functions.httpsCallable("setUserDisabledStatus");
    await fn({
      targetUserId: userId,
      disabled: action === "disable",
      reason: reason
    });
    closeToggleDisableModal();
  } catch (err) {
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300";
      alertEl.textContent = "Error: " + err.message;
      alertEl.classList.remove("hidden");
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ============================================================================
// MODAL: DELETE & BLOCK USER (Danger Zone)
// ============================================================================
function openDeleteBlockModal(userId, userName, userEmail) {
  const modal = document.getElementById("modal-delete-block");
  const uidInput = document.getElementById("delete-block-uid");
  const emailPreview = document.getElementById("delete-block-email-preview");
  const reasonInput = document.getElementById("delete-block-reason");
  const alertEl = document.getElementById("delete-block-alert");

  if (alertEl) alertEl.classList.add("hidden");
  if (uidInput) uidInput.value = userId;
  if (emailPreview) emailPreview.textContent = userEmail || "No email";
  if (reasonInput) reasonInput.value = "";

  if (modal) modal.classList.remove("hidden");
}

function closeDeleteBlockModal() {
  const modal = document.getElementById("modal-delete-block");
  if (modal) modal.classList.add("hidden");
}

async function handleDeleteBlockSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById("delete-block-uid")?.value;
  const reason = document.getElementById("delete-block-reason")?.value?.trim();
  const alertEl = document.getElementById("delete-block-alert");
  const submitBtn = document.getElementById("btn-submit-delete-block");
  const submitText = document.getElementById("btn-delete-block-text");

  if (!userId || !reason) return;

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Releasing shifts and deleting...";

  try {
    const fn = functions.httpsCallable("deleteAndBlockUser");
    const result = await fn({ targetUserId: userId, reason });
    closeDeleteBlockModal();
    alert(`Account deleted and blocked. ${result.data?.releasedShiftsCount || 0} shift(s) were automatically released back to the schedule.`);
  } catch (err) {
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300";
      alertEl.textContent = "Failed to delete & block user: " + err.message;
      alertEl.classList.remove("hidden");
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = "Release Shifts & Delete Account";
  }
}

// ============================================================================
// TAB 7: BLOCKED EMAILS MANAGEMENT
// ============================================================================
function renderBlockedEmailsTable() {
  const tbody = document.getElementById("admin-blocked-table-body");
  if (!tbody) return;

  const blockedList = Array.from(blockedEmailsMap.values());
  if (blockedList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 italic">No blocked accounts on file.</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  blockedList.forEach((b) => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-rose-50/30 transition text-xs";

    const dateStr = b.blockedAt ? formatTimestamp(b.blockedAt) : "Recently";

    tr.innerHTML = `
      <td class="p-3 font-mono font-bold text-rose-950">${escapeHtml(b.email)}</td>
      <td class="p-3 text-slate-700 font-medium">${escapeHtml(b.fullName || '—')}</td>
      <td class="p-3 text-slate-600 text-2xs italic">${escapeHtml(b.reason || 'Blocked by admin')}</td>
      <td class="p-3 text-slate-500 font-mono text-2xs">${dateStr}</td>
      <td class="p-3 text-slate-500 text-2xs font-mono">${escapeHtml(b.blockedByEmail || b.blockedBy || 'Admin')}</td>
      <td class="p-3 text-right">
        <button type="button" onclick="handleUnblockEmail('${escapeJs(b.email)}')"
          class="px-2.5 py-1 rounded-md text-2xs font-bold bg-white hover:bg-stone-100 text-slate-700 border border-slate-300 shadow-2xs transition">
          Unblock Email
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleUnblockEmail(email) {
  if (!confirm(`Are you sure you want to remove "${email}" from the blocked list? This will allow this email to register again.`)) {
    return;
  }

  try {
    const fn = functions.httpsCallable("unblockUserEmail");
    await fn({ email });
    alert(`Email "${email}" has been successfully unblocked.`);
  } catch (err) {
    alert("Failed to unblock email: " + err.message);
  }
}

// ============================================================================
// TAB 3: SHIFTS & COVERAGE MANAGEMENT (Day -> Session -> Area OR Time)
// ============================================================================

function getShiftDateStr(shift) {
  if (!shift) return "";
  if (shift.sessionId) {
    const session = (currentFestivalConfig.sessions || []).find((s) => s.id === shift.sessionId);
    if (session && session.date) return session.date;
  }
  const ms = getTimestampMs(shift.startTime);
  if (ms) {
    return new Date(ms).toISOString().split("T")[0];
  }
  return "";
}

function getUniqueFestivalDays() {
  const datesSet = new Set();
  (currentFestivalConfig.sessions || []).forEach((s) => {
    if (s.date && s.date.trim()) datesSet.add(s.date.trim());
  });
  currentShiftsDocs.forEach((d) => {
    const dStr = getShiftDateStr(d.data());
    if (dStr) datesSet.add(dStr);
  });
  const sorted = Array.from(datesSet).sort();
  return sorted;
}

function getDayInfoFromDateStr(dateStr) {
  if (!dateStr || typeof dateStr !== "string") {
    return { dateStr: "", label: "Day", dayNum: "-", month: "", displayDate: "Date TBD", fullName: "Festival Day" };
  }
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) {
        const label = d.toLocaleDateString([], { weekday: "short" });
        const dayNum = d.toLocaleDateString([], { day: "numeric" });
        const monthStr = d.toLocaleDateString([], { month: "short" });
        const fullName = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
        return {
          dateStr,
          label,
          dayNum,
          month: monthStr,
          displayDate: `${dayNum} ${monthStr}`,
          fullName
        };
      }
    }
  }
  return { dateStr, label: "Day", dayNum: dateStr, month: "", displayDate: dateStr, fullName: dateStr };
}

function setAdminShiftDay(dateStr) {
  shiftSelectedDayDate = dateStr;
  shiftSelectedSessionId = "ALL";
  shiftSessionFilter = "ALL";
  renderShiftsNavigation();
  renderShiftsPanel();
}

function setAdminShiftSession(sessionId) {
  shiftSelectedSessionId = sessionId;
  shiftSessionFilter = sessionId;
  renderShiftsNavigation();
  renderShiftsPanel();
}

function setAdminShiftGroupingMode(mode) {
  if (shiftGroupingMode === mode) return;
  shiftGroupingMode = mode;
  try {
    localStorage.setItem("brewcrew_admin_shift_grouping", mode);
  } catch (e) {
    console.warn("Could not save admin shift grouping preference", e);
  }
  updateAdminShiftGroupingButtons();
  renderShiftsPanel();
}

function updateAdminShiftGroupingButtons() {
  const btnArea = document.getElementById("admin-btn-group-area");
  const btnTime = document.getElementById("admin-btn-group-time");
  if (!btnArea || !btnTime) return;

  if (shiftGroupingMode === "area") {
    btnArea.className = "px-3 py-1.5 text-xs font-bold rounded-md transition-all duration-150 flex items-center gap-1.5 cursor-pointer touch-manipulation bg-amber-800 text-white shadow-xs";
    btnTime.className = "px-3 py-1.5 text-xs font-bold rounded-md transition-all duration-150 flex items-center gap-1.5 cursor-pointer touch-manipulation text-amber-950 hover:bg-amber-50";
  } else {
    btnTime.className = "px-3 py-1.5 text-xs font-bold rounded-md transition-all duration-150 flex items-center gap-1.5 cursor-pointer touch-manipulation bg-amber-800 text-white shadow-xs";
    btnArea.className = "px-3 py-1.5 text-xs font-bold rounded-md transition-all duration-150 flex items-center gap-1.5 cursor-pointer touch-manipulation text-amber-950 hover:bg-amber-50";
  }
}

function renderShiftsNavigation() {
  const dayPillsContainer = document.getElementById("admin-shifts-day-pills");
  const sessionChipsContainer = document.getElementById("admin-shifts-session-chips");
  const dayRangeEl = document.getElementById("admin-shifts-day-range");
  const sessionHeaderLabel = document.getElementById("admin-shifts-session-header-label");

  const uniqueDays = getUniqueFestivalDays();
  const sessions = currentFestivalConfig.sessions || [];

  // Default day if not selected or invalid
  if (!shiftSelectedDayDate || !uniqueDays.includes(shiftSelectedDayDate)) {
    shiftSelectedDayDate = uniqueDays[0] || "";
  }

  // Update Day Range Header
  if (dayRangeEl) {
    if (uniqueDays.length === 0) {
      dayRangeEl.textContent = "No festival days scheduled";
    } else if (uniqueDays.length === 1) {
      dayRangeEl.textContent = getDayInfoFromDateStr(uniqueDays[0]).fullName;
    } else {
      const first = getDayInfoFromDateStr(uniqueDays[0]);
      const last = getDayInfoFromDateStr(uniqueDays[uniqueDays.length - 1]);
      dayRangeEl.textContent = `${first.displayDate} – ${last.displayDate}`;
    }
  }

  // 1. Render Day Navigation Pills
  if (dayPillsContainer) {
    dayPillsContainer.innerHTML = "";
    if (uniqueDays.length === 0) {
      dayPillsContainer.innerHTML = `<p class="text-xs text-slate-400 italic py-2">No festival sessions configured yet. Add sessions in the Sessions & Brand tab.</p>`;
    } else {
      uniqueDays.forEach((dateStr) => {
        const isSelected = dateStr === shiftSelectedDayDate;
        const dayInfo = getDayInfoFromDateStr(dateStr);
        const dayShifts = currentShiftsDocs.filter((d) => getShiftDateStr(d.data()) === dateStr);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.onclick = () => setAdminShiftDay(dateStr);
        btn.className = `py-2 px-3 rounded-xl text-center flex flex-col items-center justify-center transition-all duration-150 border shrink-0 min-w-[72px] sm:min-w-0 min-h-[50px] cursor-pointer touch-manipulation active:scale-95 ${
          isSelected
            ? "bg-amber-800 text-white border-amber-950 shadow-sm"
            : "bg-stone-50 text-slate-800 border-amber-200/80 hover:bg-amber-50 hover:border-amber-300"
        }`;
        btn.innerHTML = `
          <span class="text-2xs font-bold uppercase tracking-wider ${isSelected ? 'text-amber-300' : 'text-slate-500'}">${escapeHtml(dayInfo.label)}</span>
          <span class="text-base font-black leading-tight tabular-nums">${escapeHtml(dayInfo.dayNum)}</span>
          <span class="text-2xs tabular-nums font-semibold mt-0.5 ${isSelected ? 'text-amber-200' : 'text-slate-400'}">${dayShifts.length} shift${dayShifts.length === 1 ? '' : 's'}</span>
        `;
        dayPillsContainer.appendChild(btn);
      });
    }
  }

  // 2. Render Session Navigation Chips for Active Day
  if (sessionChipsContainer) {
    sessionChipsContainer.innerHTML = "";

    const activeDayInfo = getDayInfoFromDateStr(shiftSelectedDayDate);
    if (sessionHeaderLabel) {
      sessionHeaderLabel.textContent = `${activeDayInfo.fullName} Sessions:`;
    }

    const daySessions = sessions.filter((s) => s.date === shiftSelectedDayDate);
    const dayShifts = currentShiftsDocs.filter((d) => getShiftDateStr(d.data()) === shiftSelectedDayDate);

    // "All Sessions" Chip
    const isAllSelected = shiftSelectedSessionId === "ALL";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.onclick = () => setAdminShiftSession("ALL");
    allBtn.className = `px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5 cursor-pointer touch-manipulation active:scale-95 ${
      isAllSelected
        ? "bg-amber-800 text-white shadow-xs"
        : "bg-white text-slate-700 hover:bg-amber-50 border border-slate-200"
    }`;
    allBtn.innerHTML = `
      <span>All Sessions</span>
      <span class="px-1.5 py-0.2 rounded-full text-2xs tabular-nums font-bold ${isAllSelected ? 'bg-amber-950/70 text-amber-200' : 'bg-slate-100 text-slate-600'}">
        ${dayShifts.length}
      </span>
    `;
    sessionChipsContainer.appendChild(allBtn);

    // Individual Session Chips
    daySessions.forEach((sess) => {
      const isSelected = shiftSelectedSessionId === sess.id;
      const sessShifts = dayShifts.filter((d) => d.data().sessionId === sess.id);
      const sessCapacity = sessShifts.reduce((acc, d) => acc + (d.data().capacity || 1), 0);
      const sessAssigned = sessShifts.reduce((acc, d) => acc + (d.data().assignedCount || 0), 0);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.onclick = () => setAdminShiftSession(sess.id);
      btn.className = `px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5 cursor-pointer touch-manipulation active:scale-95 ${
        isSelected
          ? "bg-amber-800 text-white shadow-xs"
          : "bg-white text-slate-700 hover:bg-amber-50 border border-slate-200"
      }`;
      btn.innerHTML = `
        <span>${escapeHtml(sess.name)}</span>
        <span class="text-2xs font-mono font-normal opacity-75">${escapeHtml(sess.startTime || '')}&ndash;${escapeHtml(sess.endTime || '')}</span>
        <span class="px-1.5 py-0.2 rounded-full text-2xs tabular-nums font-bold ${
          isSelected
            ? 'bg-amber-950/70 text-amber-200'
            : 'bg-slate-100 text-slate-600'
        }">
          ${sessAssigned}/${sessCapacity}
        </span>
      `;
      sessionChipsContainer.appendChild(btn);
    });
  }

  // Update grouping buttons highlight
  updateAdminShiftGroupingButtons();
}

// Backward-compatibility alias
function renderShiftsSessionFilters() {
  renderShiftsNavigation();
}

function setShiftsSessionFilter(sessionId) {
  setAdminShiftSession(sessionId);
}

function renderShiftsPanel() {
  const container = document.getElementById("admin-shifts-grouped-container");
  if (!container) return;

  const uniqueDays = getUniqueFestivalDays();
  if (!shiftSelectedDayDate && uniqueDays.length > 0) {
    shiftSelectedDayDate = uniqueDays[0];
  }

  let shifts = currentShiftsDocs.map((d) => ({ id: d.id, ...d.data() }));

  // 1. Filter by Selected Day
  if (shiftSelectedDayDate) {
    shifts = shifts.filter((s) => getShiftDateStr(s) === shiftSelectedDayDate);
  }

  // 2. Filter by Selected Session (if not ALL)
  if (shiftSelectedSessionId !== "ALL") {
    shifts = shifts.filter((s) => s.sessionId === shiftSelectedSessionId);
  }

  // Update Live Toolbar Metrics Summary
  const metricsEl = document.getElementById("admin-shifts-metrics-summary");
  const totalShifts = shifts.length;
  const totalCapacity = shifts.reduce((acc, s) => acc + (s.capacity || 1), 0);
  const totalAssigned = shifts.reduce((acc, s) => acc + (s.assignedCount || 0), 0);
  const fillPercent = totalCapacity > 0 ? Math.round((totalAssigned / totalCapacity) * 100) : 0;
  const openSpots = Math.max(0, totalCapacity - totalAssigned);

  if (metricsEl) {
    metricsEl.innerHTML = `
      <span class="tabular-nums font-bold text-slate-800">${totalShifts} Shift${totalShifts === 1 ? '' : 's'}</span>
      <span class="text-slate-300">&bull;</span>
      <span class="tabular-nums text-slate-700 font-semibold">${totalAssigned} / ${totalCapacity} Filled (${fillPercent}%)</span>
      <span class="text-slate-300">&bull;</span>
      <span class="tabular-nums font-bold ${openSpots > 0 ? 'text-amber-800' : 'text-emerald-700'}">${openSpots} Open Spot${openSpots === 1 ? '' : 's'}</span>
    `;
  }

  // If no shifts exist for the active filters
  if (shifts.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center bg-white rounded-xl border border-dashed border-amber-200 space-y-3">
        <svg class="w-10 h-10 mx-auto text-amber-700/60"><use href="#icon-clipboard" /></svg>
        <p class="text-xs font-semibold text-slate-600">No shifts scheduled for the selected day and session.</p>
        <button type="button" onclick="openCreateShiftModal()"
          class="text-xs bg-amber-700 hover:bg-amber-800 text-white font-bold px-4 py-2 rounded-lg transition shadow-sm inline-flex items-center gap-1.5 cursor-pointer">
          <svg class="w-3.5 h-3.5"><use href="#icon-plus" /></svg> Create New Shift
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = "";

  // 3. Group Shifts according to shiftGroupingMode ('area' vs 'time')
  if (shiftGroupingMode === "area") {
    // Group by Area/Category
    const groups = new Map();
    shifts.forEach((s) => {
      const areaName = (s.categoryName || "General Area").trim();
      if (!groups.has(areaName)) {
        groups.set(areaName, []);
      }
      groups.get(areaName).push(s);
    });

    // Sort Area names alphabetically
    const sortedAreas = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

    sortedAreas.forEach((areaName) => {
      const areaShifts = groups.get(areaName);
      // Sort shifts inside area chronologically by startTime
      areaShifts.sort((a, b) => getTimestampMs(a.startTime) - getTimestampMs(b.startTime));

      const groupSection = document.createElement("div");
      groupSection.className = "space-y-2.5 pt-1";

      const areaCapacity = areaShifts.reduce((acc, s) => acc + (s.capacity || 1), 0);
      const areaAssigned = areaShifts.reduce((acc, s) => acc + (s.assignedCount || 0), 0);

      const safeId = `area-grid-${areaName.replace(/[^a-zA-Z0-9]/g, '')}`;

      groupSection.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-amber-200">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-md bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
              <svg class="w-3.5 h-3.5"><use href="#icon-tag" /></svg>
            </div>
            <div class="flex items-baseline gap-2">
              <h3 class="font-bold text-slate-800 text-sm leading-tight">${escapeHtml(areaName)}</h3>
              <span class="text-2xs text-slate-500 font-medium">(${areaShifts.length} Shift${areaShifts.length === 1 ? '' : 's'})</span>
            </div>
          </div>
          <span class="px-2.5 py-0.5 rounded-full text-2xs font-bold tabular-nums ${
            areaAssigned >= areaCapacity
              ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
              : 'bg-amber-100 text-amber-900 border border-amber-300'
          }">
            ${areaAssigned} / ${areaCapacity} Volunteers Filled
          </span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" id="${safeId}">
        </div>
      `;

      const gridEl = groupSection.querySelector(`#${safeId}`);
      areaShifts.forEach((shift) => {
        gridEl.appendChild(createAdminShiftCard(shift, "area"));
      });

      container.appendChild(groupSection);
    });
  } else {
    // Group by Time Window
    const groups = new Map();
    shifts.forEach((s) => {
      const sTime = formatTime(s.startTime);
      const eTime = formatTime(s.endTime);
      const timeKey = `${sTime} – ${eTime}`;
      const startMs = getTimestampMs(s.startTime);
      const endMs = getTimestampMs(s.endTime);

      if (!groups.has(timeKey)) {
        groups.set(timeKey, {
          timeKey,
          startMs,
          endMs,
          shifts: []
        });
      }
      groups.get(timeKey).shifts.push(s);
    });

    const sortedTimeGroups = Array.from(groups.values()).sort((a, b) => {
      if (a.startMs !== b.startMs) return a.startMs - b.startMs;
      return a.endMs - b.endMs;
    });

    sortedTimeGroups.forEach((timeGroup) => {
      const timeShifts = timeGroup.shifts;
      // Sort shifts inside time window alphabetically by categoryName
      timeShifts.sort((a, b) => (a.categoryName || "").localeCompare(b.categoryName || ""));

      const groupSection = document.createElement("div");
      groupSection.className = "space-y-2.5 pt-1";

      const timeCapacity = timeShifts.reduce((acc, s) => acc + (s.capacity || 1), 0);
      const timeAssigned = timeShifts.reduce((acc, s) => acc + (s.assignedCount || 0), 0);

      const safeId = `time-grid-${timeGroup.timeKey.replace(/[^a-zA-Z0-9]/g, '')}`;

      groupSection.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-amber-200">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-md bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
              <svg class="w-3.5 h-3.5"><use href="#icon-clock" /></svg>
            </div>
            <div class="flex items-baseline gap-2">
              <h3 class="font-bold text-slate-800 text-sm leading-tight">${escapeHtml(timeGroup.timeKey)}</h3>
              <span class="text-2xs text-slate-500 font-medium">(${timeShifts.length} Shift Area${timeShifts.length === 1 ? '' : 's'})</span>
            </div>
          </div>
          <span class="px-2.5 py-0.5 rounded-full text-2xs font-bold tabular-nums ${
            timeAssigned >= timeCapacity
              ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
              : 'bg-amber-100 text-amber-900 border border-amber-300'
          }">
            ${timeAssigned} / ${timeCapacity} Volunteers Filled
          </span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" id="${safeId}">
        </div>
      `;

      const gridEl = groupSection.querySelector(`#${safeId}`);
      timeShifts.forEach((shift) => {
        gridEl.appendChild(createAdminShiftCard(shift, "time"));
      });

      container.appendChild(groupSection);
    });
  }
}

function createAdminShiftCard(shift, currentGroupingMode) {
  const card = document.createElement("div");
  card.className = "bg-white p-4 rounded-xl border border-amber-200 shadow-2xs hover:shadow-xs transition flex flex-col justify-between space-y-3";

  const sTime = formatTime(shift.startTime);
  const eTime = formatTime(shift.endTime);
  const sDate = formatDate(shift.startTime);
  const capacity = shift.capacity || 1;
  const assigned = shift.assignedCount || 0;
  const isFull = assigned >= capacity;
  const fillPercent = Math.min(100, Math.round((assigned / capacity) * 100));

  const session = (currentFestivalConfig.sessions || []).find((s) => s.id === shift.sessionId);
  const sessionName = session ? session.name : "";

  // Title & Subtitle based on grouping
  const title = currentGroupingMode === "area"
    ? `${sTime} &ndash; ${eTime}`
    : escapeHtml(shift.categoryName || 'Shift');

  const subtitle = currentGroupingMode === "area"
    ? [sessionName, sDate].filter(Boolean).join(" &bull; ")
    : [sessionName, `${sTime} - ${eTime}`].filter(Boolean).join(" &bull; ");

  // Find assigned volunteers from allRegistrationsDocs
  const shiftRegs = allRegistrationsDocs.filter((d) => d.data().shiftId === shift.id);

  let statusBadgeClass = "bg-amber-100 text-amber-900 border border-amber-300";
  if (isFull) {
    statusBadgeClass = "bg-emerald-100 text-emerald-900 border border-emerald-300";
  } else if (assigned === 0) {
    statusBadgeClass = "bg-rose-50 text-rose-800 border border-rose-200";
  }

  card.innerHTML = `
    <div class="space-y-2">
      <!-- Card Header -->
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h4 class="font-bold text-slate-800 text-sm leading-tight truncate">${title}</h4>
          <p class="text-2xs text-slate-500 font-medium mt-0.5">${subtitle}</p>
        </div>
        <span class="px-2 py-0.5 rounded-full text-2xs font-bold tabular-nums shrink-0 ${statusBadgeClass}">
          ${assigned} / ${capacity} Filled
        </span>
      </div>

      <!-- Progress Bar -->
      <div class="w-full bg-stone-100 h-1.5 rounded-full overflow-hidden">
        <div class="h-full ${isFull ? 'bg-emerald-600' : assigned === 0 ? 'bg-rose-400' : 'bg-amber-600'} transition-all duration-300" style="width: ${fillPercent}%"></div>
      </div>

      <!-- Shift Manager -->
      <div class="text-2xs text-slate-600 flex items-center justify-between pt-1 border-t border-slate-100">
        <span class="text-slate-500">Manager:</span>
        <span class="font-semibold text-slate-800 truncate">${escapeHtml(shift.managerName || 'Unassigned')}</span>
      </div>

      <!-- Volunteers Preview Chips -->
      <div class="text-2xs text-slate-500 space-y-1">
        <div class="flex items-center justify-between">
          <span class="font-bold text-slate-600">Assigned Volunteers (${shiftRegs.length}):</span>
          ${shiftRegs.length > 0 ? `<button type="button" onclick="openShiftRosterModal('${shift.id}')" class="text-amber-800 hover:text-amber-950 font-bold hover:underline cursor-pointer">View Roster</button>` : ''}
        </div>
        <div class="flex flex-wrap gap-1">
          ${shiftRegs.length > 0 ? shiftRegs.slice(0, 4).map((r) => {
            const u = allUsersMap.get(r.data().userId);
            const name = u?.fullName || u?.email || "Volunteer";
            return `<span class="px-1.5 py-0.5 bg-stone-100 border border-slate-200 rounded text-2xs text-slate-700 truncate max-w-[120px]">${escapeHtml(name)}</span>`;
          }).join("") + (shiftRegs.length > 4 ? `<span class="px-1.5 py-0.5 bg-amber-50 text-amber-800 border border-amber-200 rounded text-2xs font-bold">+${shiftRegs.length - 4} more</span>` : '') : '<span class="italic text-slate-400">None assigned</span>'}
        </div>
      </div>
    </div>

    <!-- Action Buttons -->
    <div class="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-1.5">
      <button type="button" onclick="openShiftRosterModal('${shift.id}')"
        class="px-2.5 py-1.5 rounded-lg text-2xs font-bold bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 transition min-h-[36px] flex items-center gap-1 cursor-pointer">
        <svg class="w-3.5 h-3.5"><use href="#icon-users" /></svg>
        <span>Review Roster</span>
      </button>

      <div class="flex items-center gap-1">
        <button type="button" onclick="openAssignVolunteerModal('${shift.id}', null, '${escapeJs(shift.categoryName)} (${sTime} - ${eTime})')"
          ${isFull ? 'disabled class="px-2 py-1.5 rounded-lg text-2xs font-semibold bg-stone-100 text-slate-400 border border-slate-200 cursor-not-allowed min-h-[36px]"' : 'class="px-2 py-1.5 rounded-lg text-2xs font-bold bg-amber-700 hover:bg-amber-800 text-white shadow-2xs transition min-h-[36px] cursor-pointer"'}
          title="Assign a volunteer to this shift">
          + Assign
        </button>
        <button type="button" onclick="openEditShiftModal('${shift.id}')"
          class="px-2 py-1.5 rounded-lg text-2xs font-semibold bg-white hover:bg-stone-100 text-slate-700 border border-slate-300 min-h-[36px] cursor-pointer"
          title="Edit shift details">
          Edit
        </button>
        <button type="button" onclick="handleDeleteShift('${shift.id}', '${escapeJs(shift.categoryName)}')"
          class="px-2 py-1.5 rounded-lg text-2xs font-semibold text-rose-700 hover:bg-rose-50 border border-rose-300 min-h-[36px] cursor-pointer"
          title="Delete shift">
          <svg class="w-3.5 h-3.5"><use href="#icon-trash" /></svg>
        </button>
      </div>
    </div>
  `;

  return card;
}

// ============================================================================
// MODAL: REVIEW SHIFT ROSTER & ALLOCATIONS
// ============================================================================
function openShiftRosterModal(shiftId) {
  activeRosterShiftId = shiftId;
  const modal = document.getElementById("modal-shift-roster");
  if (!modal) return;

  renderRosterModalContent(shiftId);
  modal.classList.remove("hidden");
}

function closeShiftRosterModal() {
  activeRosterShiftId = null;
  const modal = document.getElementById("modal-shift-roster");
  if (modal) modal.classList.add("hidden");
}

function renderRosterModalContent(shiftId) {
  const shiftDoc = currentShiftsDocs.find((d) => d.id === shiftId);
  if (!shiftDoc) {
    closeShiftRosterModal();
    return;
  }
  const shift = shiftDoc.data();

  const titleEl = document.getElementById("roster-modal-title");
  const subtitleEl = document.getElementById("roster-modal-subtitle");
  const mgrNameEl = document.getElementById("roster-modal-manager-name");
  const capBadgeEl = document.getElementById("roster-modal-capacity-badge");
  const progressBarEl = document.getElementById("roster-modal-progress-bar");
  const volCountEl = document.getElementById("roster-modal-volunteers-count");
  const listEl = document.getElementById("roster-modal-volunteers-list");
  const btnEditShift = document.getElementById("roster-modal-btn-edit-shift");
  const btnAssignVol = document.getElementById("roster-modal-btn-assign-vol");
  const alertEl = document.getElementById("roster-modal-alert");

  if (alertEl) alertEl.classList.add("hidden");

  const sTime = formatTime(shift.startTime);
  const eTime = formatTime(shift.endTime);
  const sDate = formatDate(shift.startTime);
  const session = (currentFestivalConfig.sessions || []).find((s) => s.id === shift.sessionId);
  const capacity = shift.capacity || 1;

  if (titleEl) {
    titleEl.textContent = `${shift.categoryName || 'Shift'} Roster`;
  }
  if (subtitleEl) {
    subtitleEl.textContent = `${session ? `${session.name} • ` : ''}${sDate} • ${sTime} – ${eTime}`;
  }
  if (mgrNameEl) {
    mgrNameEl.textContent = shift.managerName || "Unassigned (No Manager)";
  }

  // Find all confirmed registrations for this shift
  const shiftRegs = allRegistrationsDocs.filter((d) => d.data().shiftId === shiftId);
  const assigned = shiftRegs.length;
  const fillPercent = Math.min(100, Math.round((assigned / capacity) * 100));
  const isFull = assigned >= capacity;

  if (capBadgeEl) {
    capBadgeEl.textContent = `${assigned} / ${capacity} Filled (${Math.max(0, capacity - assigned)} open)`;
    capBadgeEl.className = `px-2 py-0.5 rounded-full text-2xs font-bold tabular-nums ${
      isFull
        ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
        : 'bg-amber-100 text-amber-900 border border-amber-300'
    }`;
  }

  if (progressBarEl) {
    progressBarEl.style.width = `${fillPercent}%`;
    progressBarEl.className = `h-full ${isFull ? 'bg-emerald-600' : 'bg-amber-600'} transition-all duration-300`;
  }

  if (volCountEl) {
    volCountEl.textContent = `Assigned Volunteers (${assigned} of ${capacity})`;
  }

  if (btnEditShift) {
    btnEditShift.onclick = () => {
      closeShiftRosterModal();
      openEditShiftModal(shiftId);
    };
  }

  if (btnAssignVol) {
    btnAssignVol.onclick = () => {
      openAssignVolunteerModal(shiftId, null, `${shift.categoryName || 'Shift'} (${sTime} - ${eTime})`);
    };
  }

  if (listEl) {
    listEl.innerHTML = "";

    // 1. Render Assigned Volunteers
    if (shiftRegs.length > 0) {
      shiftRegs.forEach((r) => {
        const regData = r.data();
        const u = allUsersMap.get(regData.userId) || {};
        const userName = u.fullName || u.email || "Volunteer";
        const userEmail = u.email || "";
        const userPhone = u.phoneNumber || "";
        const userRole = u.role || "volunteer";
        const groupName = u.groupId ? (allGroupsMap.get(u.groupId)?.name || u.groupOrClub) : u.groupOrClub;

        const row = document.createElement("div");
        row.className = "p-3 hover:bg-stone-50 transition rounded-lg flex flex-wrap items-center justify-between gap-3 text-xs";

        row.innerHTML = `
          <div class="flex items-start gap-2.5 min-w-0">
            <button type="button" onclick="openAdminEditUserModal('${regData.userId}')"
              title="Click to view & edit volunteer profile"
              class="group/roster flex items-start gap-2.5 text-left cursor-pointer focus:outline-none focus:ring-2 focus:ring-amber-500 rounded-lg p-1 -m-1 hover:bg-amber-100/60 transition min-w-0">
              <div class="w-8 h-8 rounded-full bg-amber-100 text-amber-900 font-bold flex items-center justify-center text-xs shrink-0 border border-amber-200 group-hover/roster:ring-2 group-hover/roster:ring-amber-500 transition">
                ${escapeHtml(userName.charAt(0).toUpperCase())}
              </div>
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="font-bold text-slate-800 group-hover/roster:text-amber-900 group-hover/roster:underline flex items-center gap-1">
                    <span>${escapeHtml(userName)}</span>
                    <svg class="w-3 h-3 text-slate-400 group-hover/roster:text-amber-700 opacity-0 group-hover/roster:opacity-100 transition shrink-0"><use href="#icon-edit" /></svg>
                  </span>
                  <span class="px-1.5 py-0.2 rounded-full text-2xs font-bold uppercase tracking-wider ${
                    userRole === 'admin' ? 'bg-purple-100 text-purple-900' :
                    userRole === 'manager' ? 'bg-blue-100 text-blue-900' :
                    'bg-stone-100 text-slate-700'
                  }">${escapeHtml(userRole)}</span>
                  ${groupName ? `<span class="px-1.5 py-0.2 rounded-full text-2xs font-semibold bg-amber-50 text-amber-900 border border-amber-200 truncate max-w-[140px]">${escapeHtml(groupName)}</span>` : ''}
                </div>
                <div class="text-2xs text-slate-500 font-mono mt-0.5 flex flex-wrap items-center gap-2" onclick="event.stopPropagation()">
                  ${userEmail ? `<a href="mailto:${escapeHtml(userEmail)}" class="text-slate-600 hover:underline flex items-center gap-1"><svg class="w-3 h-3"><use href="#icon-mail"/></svg>${escapeHtml(userEmail)}</a>` : ''}
                  ${userPhone ? `<a href="tel:${escapeHtml(userPhone)}" class="text-slate-600 hover:underline flex items-center gap-1"><svg class="w-3 h-3"><use href="#icon-phone"/></svg>${escapeHtml(userPhone)}</a>` : ''}
                </div>
                ${regData.registeredAt ? `<div class="text-2xs text-slate-400 mt-0.5">Registered: ${formatTimestamp(regData.registeredAt)}</div>` : ''}
              </div>
            </button>
          </div>
          <button type="button" onclick="handleAdminUnassignVolunteer('${shiftId}', '${regData.userId}', '${escapeJs(userName)}')"
            class="px-2.5 py-1.5 rounded-lg text-2xs font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 transition flex items-center gap-1 shrink-0 cursor-pointer"
            title="Remove volunteer from this shift">
            <svg class="w-3.5 h-3.5"><use href="#icon-x" /></svg>
            <span>Remove</span>
          </button>
        `;
        listEl.appendChild(row);
      });
    }

    // 2. Render Unfilled Open Spots
    const openSpotsCount = Math.max(0, capacity - assigned);
    if (openSpotsCount > 0) {
      for (let i = assigned + 1; i <= capacity; i++) {
        const openRow = document.createElement("div");
        openRow.className = "p-3 bg-stone-50/60 border border-dashed border-amber-200/80 rounded-lg flex items-center justify-between gap-3 text-xs";
        openRow.innerHTML = `
          <div class="flex items-center gap-2 text-slate-500">
            <div class="w-8 h-8 rounded-full border border-dashed border-slate-300 text-slate-400 font-mono flex items-center justify-center text-xs shrink-0">
              #${i}
            </div>
            <div>
              <span class="font-bold text-slate-600">Spot ${i} of ${capacity}: Open</span>
              <p class="text-2xs text-slate-400">Awaiting volunteer registration or admin assignment.</p>
            </div>
          </div>
          <button type="button" onclick="openAssignVolunteerModal('${shiftId}', null, '${escapeJs(shift.categoryName)} (${sTime} - ${eTime})')"
            class="px-2.5 py-1.5 rounded-lg text-2xs font-bold bg-amber-700 hover:bg-amber-800 text-white transition shadow-2xs flex items-center gap-1 shrink-0 cursor-pointer">
            <svg class="w-3.5 h-3.5"><use href="#icon-user-plus" /></svg>
            <span>Fill Spot</span>
          </button>
        `;
        listEl.appendChild(openRow);
      }
    }
  }
}

async function handleAdminUnassignVolunteer(shiftId, targetUserId, volunteerName) {
  if (!confirm(`Are you sure you want to remove "${volunteerName}" from this shift?\n\nTheir registration will be cancelled, their reserved spot reopened, and a cancellation notice will be dispatched.`)) {
    return;
  }

  const alertEl = document.getElementById("roster-modal-alert");
  try {
    const fn = functions.httpsCallable("cancelShift");
    await fn({ shiftId, targetUserId });
    if (alertEl) {
      showModalAlert(alertEl, `Successfully removed "${volunteerName}" from this shift.`, true);
    }
    renderRosterModalContent(shiftId);
  } catch (err) {
    if (alertEl) {
      showModalAlert(alertEl, `Failed to remove volunteer: ${err.message}`, false);
    } else {
      alert(`Failed to remove volunteer: ${err.message}`);
    }
  }
}

async function handleDeleteShift(shiftId, categoryName) {
  const shiftRegs = allRegistrationsDocs.filter((d) => d.data().shiftId === shiftId);
  if (shiftRegs.length > 0) {
    if (!confirm(`WARNING: This shift has ${shiftRegs.length} assigned volunteer(s).\n\nDeleting this shift will release those registrations. Are you sure you want to delete "${categoryName}"?`)) {
      return;
    }
  } else {
    if (!confirm(`Are you sure you want to delete the shift "${categoryName}"?`)) {
      return;
    }
  }

  try {
    await db.collection("shifts").doc(shiftId).delete();
    if (activeRosterShiftId === shiftId) {
      closeShiftRosterModal();
    }
  } catch (err) {
    alert(`Failed to delete shift: ${err.message}`);
  }
}

// ============================================================================
// MODAL: ASSIGN VOLUNTEER TO SHIFT
// ============================================================================
function openAssignVolunteerModal(presetShiftId, presetUserId, titleInfo) {
  const modal = document.getElementById("modal-assign-volunteer");
  const modalTitle = document.getElementById("assign-volunteer-modal-title");
  const shiftIdInput = document.getElementById("assign-vol-shift-id");
  const userIdInput = document.getElementById("assign-vol-user-id");
  const shiftDetailsBox = document.getElementById("assign-vol-shift-details");
  const userSelectWrap = document.getElementById("assign-vol-user-select-wrap");
  const shiftSelectWrap = document.getElementById("assign-vol-shift-select-wrap");
  const userSelect = document.getElementById("assign-vol-user-select");
  const shiftSelect = document.getElementById("assign-vol-shift-select");
  const alertEl = document.getElementById("assign-volunteer-alert");

  if (alertEl) alertEl.classList.add("hidden");
  if (shiftIdInput) shiftIdInput.value = presetShiftId || "";
  if (userIdInput) userIdInput.value = presetUserId || "";

  if (modalTitle) {
    modalTitle.textContent = titleInfo ? `Assign Volunteer: ${titleInfo}` : "Assign Volunteer to Shift";
  }

  // Populate Users Dropdown (active volunteers & managers)
  if (userSelect) {
    userSelect.innerHTML = `<option value="">-- Choose a Volunteer --</option>`;
    const users = Array.from(allUsersMap.values()).filter((u) => !u.disabled);
    users.sort((a, b) => (a.fullName || a.email || "").localeCompare(b.fullName || b.email || ""));
    users.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = `${u.fullName || 'Volunteer'} (${u.email || 'No email'}) - ${u.role || 'volunteer'}`;
      if (presetUserId && presetUserId === u.id) opt.selected = true;
      userSelect.appendChild(opt);
    });
  }

  // Populate Shifts Dropdown (shifts with open spots)
  if (shiftSelect) {
    shiftSelect.innerHTML = `<option value="">-- Choose an Available Shift --</option>`;
    const shifts = currentShiftsDocs.map((d) => ({ id: d.id, ...d.data() }));
    shifts.sort((a, b) => getTimestampMs(a.startTime) - getTimestampMs(b.startTime));
    shifts.forEach((s) => {
      const assigned = s.assignedCount || 0;
      const capacity = s.capacity || 1;
      const spotsLeft = Math.max(0, capacity - assigned);
      const opt = document.createElement("option");
      opt.value = s.id;
      const sTime = formatTime(s.startTime);
      const eTime = formatTime(s.endTime);
      const sDate = formatDate(s.startTime);
      opt.textContent = `${sDate ? `${sDate} ` : ''}${s.categoryName || 'Shift'} (${sTime}-${eTime}) [${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left]`;
      if (presetShiftId && presetShiftId === s.id) opt.selected = true;
      shiftSelect.appendChild(opt);
    });
  }

  // Determine which selector to show
  if (presetShiftId) {
    // Opened from shift card: Shift is fixed, pick volunteer
    if (userSelectWrap) userSelectWrap.classList.remove("hidden");
    if (shiftSelectWrap) shiftSelectWrap.classList.add("hidden");
    const shiftDoc = currentShiftsDocs.find((d) => d.id === presetShiftId);
    if (shiftDoc && shiftDetailsBox) {
      const s = shiftDoc.data();
      shiftDetailsBox.innerHTML = `
        <p class="font-bold text-amber-950">${escapeHtml(s.categoryName)}</p>
        <p class="text-2xs text-amber-900 font-mono">${formatDate(s.startTime)} &bull; ${formatTime(s.startTime)} &ndash; ${formatTime(s.endTime)}</p>
        <p class="text-2xs text-slate-600">Capacity: <span class="font-bold tabular-nums">${s.assignedCount || 0}/${s.capacity || 1}</span> filled</p>
      `;
      shiftDetailsBox.classList.remove("hidden");
    }
  } else if (presetUserId) {
    // Opened from crew directory row: Volunteer is fixed, pick shift
    if (shiftSelectWrap) shiftSelectWrap.classList.remove("hidden");
    if (userSelectWrap) userSelectWrap.classList.add("hidden");
    const u = allUsersMap.get(presetUserId);
    if (u && shiftDetailsBox) {
      shiftDetailsBox.innerHTML = `
        <p class="font-bold text-amber-950">${escapeHtml(u.fullName || 'Volunteer')}</p>
        <p class="text-2xs text-amber-900 font-mono">${escapeHtml(u.email || '')}</p>
        <p class="text-2xs text-slate-600">Role: <span class="font-bold uppercase">${escapeHtml(u.role || 'volunteer')}</span></p>
      `;
      shiftDetailsBox.classList.remove("hidden");
    }
  } else {
    // Neither fixed
    if (userSelectWrap) userSelectWrap.classList.remove("hidden");
    if (shiftSelectWrap) shiftSelectWrap.classList.remove("hidden");
    if (shiftDetailsBox) shiftDetailsBox.classList.add("hidden");
  }

  if (modal) modal.classList.remove("hidden");
}

function closeAssignVolunteerModal() {
  const modal = document.getElementById("modal-assign-volunteer");
  if (modal) modal.classList.add("hidden");
}

async function handleAssignVolunteerSubmit(e) {
  e.preventDefault();
  const alertEl = document.getElementById("assign-volunteer-alert");
  const submitBtn = document.getElementById("btn-submit-assign-vol");
  const submitText = document.getElementById("btn-submit-assign-vol-text");

  let shiftId = document.getElementById("assign-vol-shift-id")?.value;
  let targetUserId = document.getElementById("assign-vol-user-id")?.value;

  if (!shiftId) {
    shiftId = document.getElementById("assign-vol-shift-select")?.value;
  }
  if (!targetUserId) {
    targetUserId = document.getElementById("assign-vol-user-select")?.value;
  }

  if (!shiftId) {
    showModalAlert(alertEl, "Please select a shift.", false);
    return;
  }
  if (!targetUserId) {
    showModalAlert(alertEl, "Please select a volunteer to assign.", false);
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Assigning volunteer...";

  try {
    const fn = functions.httpsCallable("claimShift");
    await fn({ shiftId, targetUserId });
    closeAssignVolunteerModal();
    alert("Volunteer successfully assigned to shift!");
  } catch (err) {
    showModalAlert(alertEl, err.message || "Failed to assign volunteer.", false);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = "Confirm Shift Assignment";
  }
}

// ============================================================================
// TAB 2: SESSIONS & FESTIVAL CONFIGURATION
// ============================================================================
function populateFestivalConfigForm() {
  const nameInput = document.getElementById("admin-cfg-festival-name");
  const webInput = document.getElementById("admin-cfg-festival-website");
  const logoInput = document.getElementById("admin-cfg-festival-logo");
  const mgrName = document.getElementById("admin-cfg-manager-name");
  const mgrEmail = document.getElementById("admin-cfg-manager-email");
  const mgrPhone = document.getElementById("admin-cfg-manager-phone");

  if (nameInput) nameInput.value = currentFestivalConfig.festivalName || "";
  if (webInput) webInput.value = currentFestivalConfig.festivalWebsite || "";
  if (logoInput) {
    logoInput.value = currentFestivalConfig.festivalLogoUrl || "";
    previewFestivalLogo(currentFestivalConfig.festivalLogoUrl || "");
  }

  const mgr = currentFestivalConfig.volunteerManager || {};
  if (mgrName) mgrName.value = mgr.name || "";
  if (mgrEmail) mgrEmail.value = mgr.email || "";
  if (mgrPhone) mgrPhone.value = mgr.phone || "";
}

function previewFestivalLogo(url) {
  const img = document.getElementById("admin-cfg-logo-preview-img");
  const emoji = document.getElementById("admin-cfg-logo-preview-emoji");
  if (!img || !emoji) return;

  if (url && url.trim().startsWith("http")) {
    img.src = url.trim();
    img.classList.remove("hidden");
    emoji.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    emoji.classList.remove("hidden");
  }
}

function renderSessionsTable() {
  const tbody = document.getElementById("admin-sessions-table-body");
  if (!tbody) return;

  const sessions = currentFestivalConfig.sessions || [];
  if (sessions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 italic">No festival sessions configured.</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  sessions.forEach((sess) => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-amber-50/30 transition text-xs";

    const shiftCount = currentShiftsDocs.filter((d) => d.data().sessionId === sess.id).length;

    tr.innerHTML = `
      <td class="p-2.5 font-bold text-slate-800">${escapeHtml(sess.name)}</td>
      <td class="p-2.5 font-mono text-2xs text-slate-600">${escapeHtml(sess.date)}</td>
      <td class="p-2.5 font-mono text-2xs text-slate-700">${escapeHtml(sess.startTime)} &ndash; ${escapeHtml(sess.endTime)}</td>
      <td class="p-2.5 text-2xs text-slate-500">${escapeHtml(sess.description || '—')}</td>
      <td class="p-2.5 text-center">
        <span class="px-2 py-0.5 rounded-full text-2xs font-bold tabular-nums ${shiftCount > 0 ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-500'}">
          ${shiftCount} shift${shiftCount === 1 ? '' : 's'}
        </span>
      </td>
      <td class="p-2.5 text-right">
        <button type="button" onclick="handleDeleteFestivalSession('${sess.id}', '${escapeJs(sess.name)}', ${shiftCount})"
          class="px-2 py-1 rounded-md text-2xs font-bold text-rose-700 hover:bg-rose-50 border border-rose-300 transition">
          Delete
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleSaveFestivalConfig() {
  const name = document.getElementById("admin-cfg-festival-name")?.value?.trim() || "BrewCrew Festival";
  const web = document.getElementById("admin-cfg-festival-website")?.value?.trim() || "";
  const logo = document.getElementById("admin-cfg-festival-logo")?.value?.trim() || "";
  const mgrName = document.getElementById("admin-cfg-manager-name")?.value?.trim() || "";
  const mgrEmail = document.getElementById("admin-cfg-manager-email")?.value?.trim() || "";
  const mgrPhone = document.getElementById("admin-cfg-manager-phone")?.value?.trim() || "";
  const btn = document.getElementById("btn-save-sessions-cfg");

  if (btn) btn.disabled = true;
  try {
    await db.collection("config").doc("festival").set({
      festivalName: name,
      festivalWebsite: web,
      festivalLogoUrl: logo,
      volunteerManager: { name: mgrName, email: mgrEmail, phone: mgrPhone },
      sessions: currentFestivalConfig.sessions || [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    }, { merge: true });
    alert("Festival settings saved successfully!");
  } catch (err) {
    alert("Failed to save festival configuration: " + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleAddFestivalSession() {
  const nameInput = document.getElementById("admin-new-session-name");
  const dateInput = document.getElementById("admin-new-session-date");
  const startInput = document.getElementById("admin-new-session-start");
  const endInput = document.getElementById("admin-new-session-end");
  const descInput = document.getElementById("admin-new-session-desc");

  const name = nameInput?.value?.trim();
  const date = dateInput?.value;
  const startTime = startInput?.value;
  const endTime = endInput?.value;
  const desc = descInput?.value?.trim() || "";

  if (!name || !date || !startTime || !endTime) {
    alert("Please provide Session Name, Date, Start Time, and End Time.");
    return;
  }

  const newId = "sess_" + Date.now();
  const newSession = { id: newId, name, date, startTime, endTime, description: desc };

  const updatedSessions = [...(currentFestivalConfig.sessions || []), newSession];

  try {
    await db.collection("config").doc("festival").update({
      sessions: updatedSessions,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    });
    if (nameInput) nameInput.value = "";
    if (descInput) descInput.value = "";
  } catch (err) {
    alert("Failed to add session: " + err.message);
  }
}

async function handleDeleteFestivalSession(sessionId, sessionName, shiftCount) {
  if (shiftCount > 0) {
    alert(`Cannot delete session "${sessionName}" because ${shiftCount} shift(s) are currently assigned to it. Please delete or reassign associated shifts first.`);
    return;
  }

  if (!confirm(`Are you sure you want to delete session "${sessionName}"?`)) return;

  try {
    const fn = functions.httpsCallable("deleteFestivalSession");
    await fn({ sessionId });
  } catch (err) {
    alert("Delete session failed: " + err.message);
  }
}

// ============================================================================
// TAB 4: INCENTIVES & MILESTONE REWARDS
// ============================================================================
function populateIncentivesForm() {
  const title = document.getElementById("admin-incentive-welcome-title");
  const text = document.getElementById("admin-incentive-welcome-text");
  if (title) title.value = currentIncentivesConfig.welcomeTitle || "";
  if (text) text.value = currentIncentivesConfig.welcomeText || "";
}

function renderIncentivesTable() {
  const tbody = document.getElementById("admin-incentives-table-body");
  if (!tbody) return;

  const items = currentIncentivesConfig.items || [];
  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-slate-400 italic">No milestone rewards configured.</td></tr>`;
    return;
  }

  items.sort((a, b) => (a.hours || a.hoursRequired || 0) - (b.hours || b.hoursRequired || 0));

  tbody.innerHTML = "";
  items.forEach((item, idx) => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-amber-50/30 transition text-xs";
    const hrs = item.hours || item.hoursRequired || 0;
    const name = item.name || item.rewardName || "";

    tr.innerHTML = `
      <td class="p-2.5 font-bold font-mono tabular-nums text-amber-950">${hrs} hr${hrs === 1 ? '' : 's'}</td>
      <td class="p-2.5 font-semibold text-slate-800">${escapeHtml(name)}</td>
      <td class="p-2.5 text-2xs text-slate-500">${escapeHtml(item.description || '—')}</td>
      <td class="p-2.5 text-right">
        <button type="button" onclick="handleDeleteIncentive(${idx})"
          class="px-2 py-1 rounded-md text-2xs font-bold text-rose-700 hover:bg-rose-50 border border-rose-300 transition">
          Delete
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleAddIncentive() {
  const hrsInput = document.getElementById("admin-new-incentive-hours");
  const nameInput = document.getElementById("admin-new-incentive-name");
  const descInput = document.getElementById("admin-new-incentive-desc");

  const hrs = Math.round(parseFloat(hrsInput?.value));
  const name = nameInput?.value?.trim();
  const desc = descInput?.value?.trim() || "";

  if (isNaN(hrs) || hrs <= 0 || !name) {
    alert("Please enter a valid whole hours milestone and reward name.");
    return;
  }

  const newItem = {
    id: "inc_" + Date.now(),
    hours: hrs,
    hoursRequired: hrs,
    name: name,
    rewardName: name,
    description: desc
  };

  const updatedItems = [...(currentIncentivesConfig.items || []), newItem];

  try {
    await db.collection("config").doc("incentives").set({
      ...currentIncentivesConfig,
      items: updatedItems,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    }, { merge: true });
    if (hrsInput) hrsInput.value = "";
    if (nameInput) nameInput.value = "";
    if (descInput) descInput.value = "";
  } catch (err) {
    alert("Failed to add reward milestone: " + err.message);
  }
}

async function handleDeleteIncentive(index) {
  if (!confirm("Are you sure you want to remove this milestone reward?")) return;
  const items = [...(currentIncentivesConfig.items || [])];
  items.splice(index, 1);

  try {
    await db.collection("config").doc("incentives").update({
      items: items,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    });
  } catch (err) {
    alert("Failed to delete milestone: " + err.message);
  }
}

async function handleSaveIncentivesConfig() {
  const title = document.getElementById("admin-incentive-welcome-title")?.value?.trim() || "";
  const text = document.getElementById("admin-incentive-welcome-text")?.value?.trim() || "";
  const btn = document.getElementById("btn-save-incentives");

  if (btn) btn.disabled = true;
  try {
    await db.collection("config").doc("incentives").set({
      welcomeTitle: title,
      welcomeText: text,
      items: currentIncentivesConfig.items || [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    }, { merge: true });
    alert("Incentives configuration saved!");
  } catch (err) {
    alert("Failed to save incentives: " + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ============================================================================
// TAB 5: ROLE GUIDES & AREA BRIEFINGS
// ============================================================================
function renderRolesTable() {
  const tbody = document.getElementById("admin-roles-table-body");
  if (!tbody) return;

  const categories = [...new Set(
    currentShiftsDocs.map((d) => d.data().categoryName).filter((c) => c && typeof c === "string")
  )].sort();

  if (categories.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-slate-400 italic">No shift areas detected. Create shifts first to configure roles.</td></tr>`;
    return;
  }

  const rolesMap = currentRolesConfig.roles || {};
  tbody.innerHTML = "";

  categories.forEach((cat) => {
    const roleData = rolesMap[cat] || {};
    const tr = document.createElement("tr");
    tr.className = "hover:bg-amber-50/30 transition text-xs";

    const hasBriefing = Boolean(roleData.description && roleData.description.length > 20);

    tr.innerHTML = `
      <td class="p-2.5 text-center text-base">${escapeHtml(roleData.icon || '🍺')}</td>
      <td class="p-2.5 font-bold text-slate-800">${escapeHtml(cat)}</td>
      <td class="p-2.5 text-2xs text-slate-600">${escapeHtml(roleData.summary || 'No summary set.')}</td>
      <td class="p-2.5 text-center">
        <span class="px-2 py-0.5 rounded-full text-2xs font-bold ${hasBriefing ? 'bg-emerald-50 text-emerald-800 border border-emerald-300' : 'bg-amber-50 text-amber-800 border border-amber-300'}">
          ${hasBriefing ? 'Detailed' : 'Brief'}
        </span>
      </td>
      <td class="p-2.5 text-right">
        <button type="button" onclick="openEditRoleModal('${escapeJs(cat)}')"
          class="px-2.5 py-1 rounded-md text-2xs font-semibold bg-white hover:bg-stone-100 text-slate-700 border border-slate-300">
          Edit Guide
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openEditRoleModal(categoryName) {
  const rolesMap = currentRolesConfig.roles || {};
  const role = rolesMap[categoryName] || {};

  const icon = prompt(`Emoji icon for "${categoryName}":`, role.icon || "🍺");
  if (icon === null) return;

  const summary = prompt(`Summary blurb for "${categoryName}" (1-2 sentences):`, role.summary || "");
  if (summary === null) return;

  saveRoleInfo(categoryName, icon, summary, role.description || "");
}

async function saveRoleInfo(categoryName, icon, summary, desc) {
  try {
    const rolesMap = { ...(currentRolesConfig.roles || {}) };
    rolesMap[categoryName] = {
      icon: (icon || "🍺").trim(),
      summary: (summary || "").trim(),
      description: desc || "",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    };

    await db.collection("config").doc("roles").set({
      roles: rolesMap,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    }, { merge: true });

    alert(`Role guide for "${categoryName}" updated!`);
  } catch (err) {
    alert("Failed to save role info: " + err.message);
  }
}

// ============================================================================
// TAB 6: OMNICHANNEL COMMUNICATIONS & ANNOUNCEMENTS CONSOLE
// ============================================================================
let commActiveChannel = "email"; // "email" | "whatsapp"
let commSelectedUserIds = new Set();
let commUserSearchQuery = "";
let commRecentDispatches = [];

try {
  const cachedHistory = localStorage.getItem("brewcrew_comm_history");
  if (cachedHistory) {
    commRecentDispatches = JSON.parse(cachedHistory);
  }
} catch (e) {
  commRecentDispatches = [];
}

/**
 * Normalizes phone number to E.164 for client-side readiness checks
 */
function normalizeE164Client(rawPhone) {
  if (!rawPhone || typeof rawPhone !== "string") return null;
  let cleaned = rawPhone.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("00")) {
    cleaned = "+" + cleaned.slice(2);
  }
  if (cleaned.startsWith("07") && cleaned.length === 11) {
    cleaned = "+44" + cleaned.slice(1);
  }
  if (!cleaned.startsWith("+") && cleaned.length >= 10) {
    cleaned = "+" + cleaned;
  }
  return /^\+[1-9]\d{7,14}$/.test(cleaned) ? cleaned : null;
}

/**
 * Initializes or refreshes communications targeting options and preview
 */
function initOrRefreshCommConsole() {
  populateCommContextOptions();
  updateCommTargetPreview();
  updateCommLivePreview();
  renderCommHistory();
}

/**
 * Switches composer between Email and WhatsApp mode
 * @param {"email"|"whatsapp"} channel
 */
function switchCommChannel(channel) {
  commActiveChannel = channel;

  const emailBtn = document.getElementById("comm-channel-email-btn");
  const waBtn = document.getElementById("comm-channel-whatsapp-btn");
  const subjectContainer = document.getElementById("comm-subject-field-container");
  const mirrorLabel = document.getElementById("comm-mirror-label");
  const previewEmail = document.getElementById("comm-preview-email-card");
  const previewWa = document.getElementById("comm-preview-whatsapp-card");
  const previewChannelName = document.getElementById("comm-preview-channel-name");
  const btnIcon = document.getElementById("btn-broadcast-icon");
  const formattingHint = document.getElementById("comm-formatting-hint");

  if (channel === "whatsapp") {
    if (emailBtn) {
      emailBtn.className = "flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold transition min-h-[44px] bg-stone-100 text-slate-700 hover:bg-stone-200 border border-slate-200";
    }
    if (waBtn) {
      waBtn.className = "flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold transition min-h-[44px] bg-emerald-700 text-white shadow-xs";
    }
    if (subjectContainer) subjectContainer.classList.add("hidden");
    if (mirrorLabel) mirrorLabel.textContent = "Also mirror and send via Email";
    if (previewEmail) previewEmail.classList.add("hidden");
    if (previewWa) previewWa.classList.remove("hidden");
    if (previewChannelName) previewChannelName.textContent = "WhatsApp";
    if (btnIcon) btnIcon.innerHTML = '<use href="#icon-whatsapp" />';
    if (formattingHint) {
      formattingHint.textContent = "Use *bold*, _italics_, and placeholders. Sent directly to volunteer WhatsApp apps via Twilio.";
    }
  } else {
    // email
    if (emailBtn) {
      emailBtn.className = "flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold transition min-h-[44px] bg-amber-700 text-white shadow-xs";
    }
    if (waBtn) {
      waBtn.className = "flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold transition min-h-[44px] bg-stone-100 text-slate-700 hover:bg-stone-200 border border-slate-200";
    }
    if (subjectContainer) subjectContainer.classList.remove("hidden");
    if (mirrorLabel) mirrorLabel.textContent = "Also mirror and send via WhatsApp";
    if (previewEmail) previewEmail.classList.remove("hidden");
    if (previewWa) previewWa.classList.add("hidden");
    if (previewChannelName) previewChannelName.textContent = "Email";
    if (btnIcon) btnIcon.innerHTML = '<use href="#icon-mail" />';
    if (formattingHint) {
      formattingHint.textContent = "Line breaks are converted into formatted paragraphs. Use dynamic placeholders to personalize each message.";
    }
  }

  updateCommLivePreview();
  updateCommTargetPreview();
}

/**
 * Handles change of Primary Target Group dropdown
 */
function handleCommTargetTypeChange(type) {
  const contextContainer = document.getElementById("comm-context-container");
  const userPickerContainer = document.getElementById("comm-user-picker-container");

  if (type === "all") {
    if (contextContainer) contextContainer.classList.add("hidden");
    if (userPickerContainer) userPickerContainer.classList.add("hidden");
  } else if (type === "users") {
    if (contextContainer) contextContainer.classList.add("hidden");
    if (userPickerContainer) {
      userPickerContainer.classList.remove("hidden");
      renderCommUserList();
    }
  } else {
    // role, category, shift
    if (contextContainer) contextContainer.classList.remove("hidden");
    if (userPickerContainer) userPickerContainer.classList.add("hidden");
    populateCommContextOptions();
  }

  updateCommTargetPreview();
  updateCommLivePreview();
}

/**
 * Populates secondary context dropdown based on primary target type
 */
function populateCommContextOptions() {
  const targetType = document.getElementById("comm-target-type")?.value || "all";
  const contextSelect = document.getElementById("comm-context-select");
  const contextLabel = document.getElementById("comm-context-label");
  if (!contextSelect) return;

  contextSelect.innerHTML = "";

  if (targetType === "role") {
    if (contextLabel) contextLabel.textContent = "Role Group";
    contextSelect.innerHTML = `
      <option value="volunteer">Volunteers Only</option>
      <option value="manager">Shift Managers Only</option>
    `;
  } else if (targetType === "category") {
    if (contextLabel) contextLabel.textContent = "Area / Bar Category";
    const categoriesSet = new Set();
    currentShiftsDocs.forEach((d) => {
      const cat = d.data().categoryName;
      if (cat && typeof cat === "string" && cat.trim()) {
        categoriesSet.add(cat.trim());
      }
    });
    const categories = Array.from(categoriesSet).sort((a, b) => a.localeCompare(b));
    if (categories.length === 0) {
      contextSelect.innerHTML = `<option value="">No shift categories found</option>`;
    } else {
      contextSelect.innerHTML = categories
        .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
        .join("");
    }
  } else if (targetType === "shift") {
    if (contextLabel) contextLabel.textContent = "Specific Shift Slot";
    const shifts = currentShiftsDocs.map((d) => ({ id: d.id, ...d.data() }));
    shifts.sort((a, b) => {
      const msA = a.startTime?.seconds ? a.startTime.seconds * 1000 : new Date(a.startTime || 0).getTime();
      const msB = b.startTime?.seconds ? b.startTime.seconds * 1000 : new Date(b.startTime || 0).getTime();
      return msA - msB;
    });

    if (shifts.length === 0) {
      contextSelect.innerHTML = `<option value="">No shifts available</option>`;
    } else {
      contextSelect.innerHTML = shifts
        .map((s) => {
          const startMs = s.startTime?.seconds ? s.startTime.seconds * 1000 : new Date(s.startTime || 0).getTime();
          const endMs = s.endTime?.seconds ? s.endTime.seconds * 1000 : new Date(s.endTime || 0).getTime();
          const dateStr = startMs ? new Date(startMs).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "Date TBD";
          const timeStr = startMs && endMs ? `${new Date(startMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}-${new Date(endMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : "";
          const area = s.categoryName || s.role || "Shift";
          return `<option value="${s.id}">[${dateStr} ${timeStr}] ${escapeHtml(area)} (${s.assignedCount || 0}/${s.capacity || 0} crew)</option>`;
        })
        .join("");
    }
  }
}

function handleCommContextChange() {
  updateCommTargetPreview();
  updateCommLivePreview();
}

/**
 * Renders the searchable volunteer checkbox list for specific user targeting
 */
function renderCommUserList() {
  const container = document.getElementById("comm-user-list-items");
  if (!container) return;

  const users = Array.from(allUsersMap.values()).filter((u) => !u.disabled);
  const q = commUserSearchQuery.toLowerCase().trim();

  const filtered = users.filter((u) => {
    if (!q) return true;
    const nameMatch = (u.fullName || "").toLowerCase().includes(q);
    const emailMatch = (u.email || "").toLowerCase().includes(q);
    const phoneMatch = (u.phoneNumber || "").toLowerCase().includes(q);
    return nameMatch || emailMatch || phoneMatch;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="p-3 text-center text-xs text-slate-400 italic">No volunteers matching search query.</div>`;
    return;
  }

  container.innerHTML = filtered.map((u) => {
    const isChecked = commSelectedUserIds.has(u.id);
    const shiftCount = allRegistrationsDocs.filter((d) => d.data().userId === u.id).length;
    const hasPhone = Boolean(normalizeE164Client(u.phoneNumber));
    const roleBadge = u.role === "manager"
      ? `<span class="px-1.5 py-0.5 rounded text-3xs font-bold bg-blue-100 text-blue-800 uppercase">Manager</span>`
      : u.role === "admin"
      ? `<span class="px-1.5 py-0.5 rounded text-3xs font-bold bg-purple-100 text-purple-800 uppercase">Admin</span>`
      : `<span class="px-1.5 py-0.5 rounded text-3xs font-bold bg-amber-100 text-amber-800 uppercase">Volunteer</span>`;

    return `
      <label class="flex items-center justify-between p-2 hover:bg-amber-50/60 rounded cursor-pointer transition">
        <div class="flex items-center gap-2.5 min-w-0">
          <input type="checkbox" ${isChecked ? "checked" : ""} onchange="toggleCommUserSelect('${u.id}', this.checked)"
            class="rounded border-slate-300 text-amber-700 focus:ring-amber-500 w-4 h-4 cursor-pointer">
          <div class="w-6 h-6 rounded-full bg-amber-200 text-amber-900 font-bold text-3xs flex items-center justify-center shrink-0">
            ${escapeHtml((u.fullName || "V").charAt(0).toUpperCase())}
          </div>
          <div class="min-w-0">
            <span class="block text-xs font-semibold text-slate-800 truncate">${escapeHtml(u.fullName || "Volunteer")}</span>
            <span class="block text-3xs text-slate-400 truncate">${escapeHtml(u.email || "")}</span>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${roleBadge}
          <span class="text-3xs font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 tabular-nums">
            ${shiftCount} shift${shiftCount === 1 ? "" : "s"}
          </span>
          <span title="${hasPhone ? 'WhatsApp Ready: ' + (u.phoneNumber || '') : 'No valid mobile phone'}"
            class="w-4 h-4 flex items-center justify-center rounded-full ${hasPhone ? 'text-emerald-700 bg-emerald-50' : 'text-slate-300'}">
            <svg class="w-3 h-3"><use href="#icon-whatsapp" /></svg>
          </span>
        </div>
      </label>
    `;
  }).join("");
}

function filterCommUserList(q) {
  commUserSearchQuery = q || "";
  renderCommUserList();
}

function toggleCommUserSelect(uid, checked) {
  if (checked) {
    commSelectedUserIds.add(uid);
  } else {
    commSelectedUserIds.delete(uid);
  }
  updateCommTargetPreview();
  updateCommLivePreview();
}

function selectAllCommUsers(select) {
  const users = Array.from(allUsersMap.values()).filter((u) => !u.disabled);
  const q = commUserSearchQuery.toLowerCase().trim();
  const visible = users.filter((u) => {
    if (!q) return true;
    return (u.fullName || "").toLowerCase().includes(q) ||
           (u.email || "").toLowerCase().includes(q) ||
           (u.phoneNumber || "").toLowerCase().includes(q);
  });

  visible.forEach((u) => {
    if (select) {
      commSelectedUserIds.add(u.id);
    } else {
      commSelectedUserIds.delete(u.id);
    }
  });

  renderCommUserList();
  updateCommTargetPreview();
  updateCommLivePreview();
}

/**
 * Resolves current client targeting criteria into matching crew objects
 */
function getResolvedCommRecipients() {
  const targetType = document.getElementById("comm-target-type")?.value || "all";
  const contextVal = document.getElementById("comm-context-select")?.value || "";
  const onlyConfirmed = document.getElementById("comm-only-confirmed-shifts")?.checked || false;

  const users = Array.from(allUsersMap.values()).filter((u) => !u.disabled);

  // Map user shifts
  const userShiftsMap = new Map();
  allRegistrationsDocs.forEach((d) => {
    const r = d.data();
    if (r.status === "confirmed" && r.userId) {
      if (!userShiftsMap.has(r.userId)) userShiftsMap.set(r.userId, []);
      const shiftDoc = currentShiftsDocs.find((sd) => sd.id === r.shiftId);
      if (shiftDoc) {
        userShiftsMap.get(r.userId).push({ id: shiftDoc.id, ...shiftDoc.data() });
      }
    }
  });

  // Include managed shifts
  currentShiftsDocs.forEach((sd) => {
    const s = sd.data();
    if (s.managerId) {
      if (!userShiftsMap.has(s.managerId)) userShiftsMap.set(s.managerId, []);
      userShiftsMap.get(s.managerId).push({ id: sd.id, ...s });
    }
  });

  let matching = [];
  let targetDesc = "All Crew";

  if (targetType === "role") {
    matching = users.filter((u) => u.role === contextVal);
    targetDesc = contextVal === "manager" ? "Shift Managers" : "Volunteers";
  } else if (targetType === "category") {
    matching = users.filter((u) => {
      const userShifts = userShiftsMap.get(u.id) || [];
      return userShifts.some((s) => s.categoryName && s.categoryName.trim() === contextVal.trim());
    });
    targetDesc = `Area: ${contextVal || "Category"}`;
  } else if (targetType === "shift") {
    matching = users.filter((u) => {
      const userShifts = userShiftsMap.get(u.id) || [];
      return userShifts.some((s) => s.id === contextVal);
    });
    const sDoc = currentShiftsDocs.find((sd) => sd.id === contextVal);
    targetDesc = sDoc ? `Shift: ${sDoc.data().categoryName || 'Shift'}` : "Specific Shift";
  } else if (targetType === "users") {
    matching = users.filter((u) => commSelectedUserIds.has(u.id));
    targetDesc = `${matching.length} Selected Volunteer${matching.length === 1 ? '' : 's'}`;
  } else {
    // all
    matching = users;
    targetDesc = "All Festival Crew";
  }

  if (onlyConfirmed) {
    matching = matching.filter((u) => (userShiftsMap.get(u.id) || []).length > 0);
    targetDesc += " (Confirmed Shifts Only)";
  }

  const emailReadyCount = matching.filter((u) => u.emailNotifications !== false && u.email && u.email.includes("@")).length;
  const whatsappReadyCount = matching.filter((u) => u.whatsappNotifications !== false && Boolean(normalizeE164Client(u.phoneNumber))).length;

  const mirrorActive = document.getElementById("comm-mirror-channel")?.checked || false;
  let activeReady = commActiveChannel === "email" ? emailReadyCount : whatsappReadyCount;
  if (mirrorActive) {
    activeReady = commActiveChannel === "email" ? emailReadyCount : whatsappReadyCount;
  }
  const skippedCount = Math.max(0, matching.length - activeReady);

  return {
    matchingUsers: matching,
    targetDesc,
    emailReadyCount,
    whatsappReadyCount,
    skippedCount
  };
}

/**
 * Updates real-time recipient counts and target summary badges
 */
function updateCommTargetPreview() {
  const { matchingUsers, targetDesc, emailReadyCount, whatsappReadyCount, skippedCount } = getResolvedCommRecipients();

  const badgeText = document.getElementById("comm-target-summary-text");
  const statMatching = document.getElementById("comm-stat-matching");
  const statEmail = document.getElementById("comm-stat-email-ready");
  const statWa = document.getElementById("comm-stat-whatsapp-ready");
  const statSkipped = document.getElementById("comm-stat-skipped");

  if (badgeText) {
    badgeText.textContent = `Target: ${targetDesc} • ${matchingUsers.length} crew`;
  }
  if (statMatching) statMatching.textContent = matchingUsers.length;
  if (statEmail) statEmail.textContent = emailReadyCount;
  if (statWa) statWa.textContent = whatsappReadyCount;
  if (statSkipped) statSkipped.textContent = skippedCount;
}

/**
 * Quick Starter templates for operational messaging
 */
function applyCommStarter(key) {
  const subjectInput = document.getElementById("admin-broadcast-subject");
  const bodyInput = document.getElementById("admin-broadcast-body");

  let subject = "";
  let body = "";

  if (key === "briefing") {
    subject = "{{first_name}}, shift arrival briefing for {{category}}";
    body = `Hi {{first_name}},\n\nHere is your operational briefing for your upcoming shift on {{date}} ({{time}}) at {{category}}.\n\nPlease arrive 10 minutes before your start time at the Volunteer Check-In desk. Wear comfortable footwear and bring your festival wristband.\n\nYour scheduled shifts:\n{{all_shifts}}\n\nThank you for making BrewCrew great!`;
  } else if (key === "age_rules") {
    subject = "{{category}} Team: Important Challenge 25 & Token Policy";
    body = `Hi {{first_name}},\n\nA quick reminder of our core licensing rules for all volunteers at {{category}}:\n\n1. Challenge 25 is strictly enforced — if a customer looks under 25, ask for valid photo ID.\n2. We do not accept cash at the bar — all purchases must be made via official festival tokens or contactless.\n3. Drink sensibly — volunteers may not consume alcohol during active shifts.\n\nYour shifts:\n{{all_shifts}}\n\nCheers,\nVolunteer Coordinator`;
  } else if (key === "schedule_reminder") {
    subject = "Festival Week Alert: Your BrewCrew Shift Schedule";
    body = `Hi {{name}},\n\nThe festival is just around the corner! Here is your current confirmed volunteering schedule:\n\n{{all_shifts}}\n\nIf you have any conflicts or need to swap shifts, please check the BrewCrew app immediately so our coordinators can reassign cover.\n\nSee you on site!`;
  } else if (key === "thank_you") {
    subject = "Thank you for volunteering with BrewCrew!";
    body = `Hi {{first_name}},\n\nA huge thank you for your fantastic work supporting {{category}} during the festival!\n\nYour energy and dedication helped make this event a tremendous success. Don't forget to stop by the volunteer lounge to collect your commemorative festival cup and crew pin.\n\nCheers and see you next year!`;
  }

  if (subjectInput && commActiveChannel === "email") {
    subjectInput.value = subject;
  }
  if (bodyInput) {
    bodyInput.value = body;
  }

  handleCommBodyInput();
}

/**
 * Inserts dynamic tag into cursor position of message textarea
 */
function insertCommPlaceholder(token) {
  const textarea = document.getElementById("admin-broadcast-body");
  if (!textarea) return;

  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const val = textarea.value;

  textarea.value = val.substring(0, start) + token + val.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + token.length;
  textarea.focus();

  handleCommBodyInput();
}

function handleCommBodyInput() {
  const bodyVal = document.getElementById("admin-broadcast-body")?.value || "";
  const counter = document.getElementById("comm-char-counter");
  if (counter) {
    counter.textContent = `${bodyVal.length} character${bodyVal.length === 1 ? '' : 's'}`;
  }
  updateCommLivePreview();
}

/**
 * Real-time live preview rendering for Email and WhatsApp simulated cards
 */
function updateCommLivePreview() {
  const subjectInput = document.getElementById("admin-broadcast-subject");
  const bodyInput = document.getElementById("admin-broadcast-body");
  const subject = (subjectInput?.value || "").trim() || "Festival Announcement";
  const body = (bodyInput?.value || "").trim() || "Write your announcement content above to see live preview...";

  // Sample Volunteer Context
  const sampleUser = {
    fullName: "Alex Green",
    firstName: "Alex",
    category: "Keg Bar",
    date: "Sat 3 Aug",
    time: "12:00 - 17:00",
    allShiftsHtml: `<ul style="margin: 8px 0; padding-left: 20px; line-height: 1.6;"><li style="margin-bottom: 4px;"><strong>Sat 3 Aug (12:00 - 17:00)</strong>: Keg Bar</li><li style="margin-bottom: 4px;"><strong>Sun 4 Aug (17:00 - 22:00)</strong>: Cider Bar</li></ul>`,
    allShiftsMd: `• *Sat 3 Aug (12:00 - 17:00)*: Keg Bar\n• *Sun 4 Aug (17:00 - 22:00)*: Cider Bar`
  };

  const festivalName = currentFestivalConfig.festivalName || "BrewCrew Festival";
  const prevFestName = document.getElementById("comm-preview-festival-name");
  if (prevFestName) prevFestName.textContent = festivalName;

  // Substitute tags for sample preview
  const subTokens = (raw, isEmail) => {
    return raw
      .replace(/\{\{\s*name\s*\}\}/gi, sampleUser.fullName)
      .replace(/\{\{\s*first_name\s*\}\}/gi, sampleUser.firstName)
      .replace(/\{\{\s*all_shifts\s*\}\}/gi, isEmail ? sampleUser.allShiftsHtml : sampleUser.allShiftsMd)
      .replace(/\{\{\s*category\s*\}\}/gi, sampleUser.category)
      .replace(/\{\{\s*date\s*\}\}/gi, sampleUser.date)
      .replace(/\{\{\s*time\s*\}\}/gi, sampleUser.time);
  };

  // 1. Email Preview
  const previewEmailSubject = document.getElementById("comm-preview-email-subject");
  const previewEmailBody = document.getElementById("comm-preview-email-body");
  if (previewEmailSubject) {
    previewEmailSubject.textContent = subTokens(subject, true);
  }
  if (previewEmailBody) {
    const substitutedEmailBody = subTokens(body, true);
    // Split on double newlines to make paragraphs, preserving embedded <ul>
    const paragraphs = substitutedEmailBody.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    previewEmailBody.innerHTML = paragraphs.map((block) => {
      if (block.startsWith("<ul") || block.startsWith("<ol") || block.startsWith("<div") || block.startsWith("<p")) {
        return block;
      }
      return `<p style="margin: 0 0 10px 0;">${block.replace(/\n/g, "<br/>")}</p>`;
    }).join("");
  }

  // 2. WhatsApp Preview
  const previewWaBody = document.getElementById("comm-preview-whatsapp-body");
  if (previewWaBody) {
    const substitutedWa = subTokens(body, false);
    // Escape HTML first then parse WhatsApp markdown *bold*, _italic_
    let formatted = escapeHtml(substitutedWa);
    formatted = formatted.replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>");
    formatted = formatted.replace(/_([^_\n]+)_/g, "<em>$1</em>");
    previewWaBody.innerHTML = formatted;
  }
}

/**
 * Opens pre-flight safety review modal
 */
function openCommReviewModal() {
  const subjectInput = document.getElementById("admin-broadcast-subject");
  const bodyInput = document.getElementById("admin-broadcast-body");
  const subject = (subjectInput?.value || "").trim();
  const body = (bodyInput?.value || "").trim();

  if (commActiveChannel === "email" && !subject) {
    showBroadcastAlert("Please enter an email subject before dispatching.", false);
    return;
  }
  if (!body) {
    showBroadcastAlert("Please enter message content before dispatching.", false);
    return;
  }

  const { matchingUsers, targetDesc, emailReadyCount, whatsappReadyCount, skippedCount } = getResolvedCommRecipients();
  if (matchingUsers.length === 0) {
    showBroadcastAlert("Selected target criteria matches 0 crew members.", false);
    return;
  }

  const mirrorActive = document.getElementById("comm-mirror-channel")?.checked || false;
  const reviewChannels = document.getElementById("comm-review-channels");
  const reviewTarget = document.getElementById("comm-review-target");
  const reviewCount = document.getElementById("comm-review-count");
  const reviewSkipped = document.getElementById("comm-review-skipped");
  const reviewPreviewText = document.getElementById("comm-review-preview-text");

  let channelBadges = "";
  let readyCount = 0;
  if (commActiveChannel === "email") {
    channelBadges += `<span class="px-2 py-0.5 rounded bg-blue-100 text-blue-900 font-bold text-3xs uppercase">Email</span>`;
    readyCount = emailReadyCount;
    if (mirrorActive) {
      channelBadges += `<span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold text-3xs uppercase">WhatsApp (Mirrored)</span>`;
    }
  } else {
    channelBadges += `<span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold text-3xs uppercase">WhatsApp</span>`;
    readyCount = whatsappReadyCount;
    if (mirrorActive) {
      channelBadges += `<span class="px-2 py-0.5 rounded bg-blue-100 text-blue-900 font-bold text-3xs uppercase">Email (Mirrored)</span>`;
    }
  }

  if (reviewChannels) reviewChannels.innerHTML = channelBadges;
  if (reviewTarget) reviewTarget.textContent = targetDesc;
  if (reviewCount) reviewCount.textContent = `${readyCount} Recipient${readyCount === 1 ? '' : 's'}`;
  if (reviewSkipped) reviewSkipped.textContent = `${skippedCount} Skipped`;

  const sampleBody = body
    .replace(/\{\{\s*name\s*\}\}/gi, "Alex Green")
    .replace(/\{\{\s*first_name\s*\}\}/gi, "Alex")
    .replace(/\{\{\s*all_shifts\s*\}\}/gi, "• Sat 3 Aug (12:00 - 17:00): Keg Bar\n• Sun 4 Aug (17:00 - 22:00): Cider Bar")
    .replace(/\{\{\s*category\s*\}\}/gi, "Keg Bar")
    .replace(/\{\{\s*date\s*\}\}/gi, "Sat 3 Aug")
    .replace(/\{\{\s*time\s*\}\}/gi, "12:00 - 17:00");

  if (reviewPreviewText) {
    reviewPreviewText.textContent = (commActiveChannel === "email" && subject ? `Subject: ${subject}\n\n` : "") + sampleBody;
  }

  const modal = document.getElementById("modal-comm-review");
  if (modal) modal.classList.remove("hidden");
}

function closeCommReviewModal() {
  const modal = document.getElementById("modal-comm-review");
  if (modal) modal.classList.add("hidden");
}

/**
 * Executes the dispatch call across Email and/or WhatsApp via Cloud Functions
 */
async function executeCommDispatch() {
  const subjectInput = document.getElementById("admin-broadcast-subject");
  const bodyInput = document.getElementById("admin-broadcast-body");
  const targetType = document.getElementById("comm-target-type")?.value || "all";
  const contextVal = document.getElementById("comm-context-select")?.value || "";
  const onlyConfirmed = document.getElementById("comm-only-confirmed-shifts")?.checked || false;
  const mirrorActive = document.getElementById("comm-mirror-channel")?.checked || false;
  const confirmBtn = document.getElementById("btn-confirm-comm-dispatch");
  const confirmText = document.getElementById("btn-confirm-dispatch-text");

  const subject = (subjectInput?.value || "").trim();
  const body = (bodyInput?.value || "").trim();

  const payload = {
    targetType,
    onlyWithConfirmedShifts: onlyConfirmed,
    body
  };

  if (targetType === "role") {
    payload.targetRole = contextVal;
  } else if (targetType === "category") {
    payload.targetCategory = contextVal;
  } else if (targetType === "shift") {
    payload.targetShiftId = contextVal;
  } else if (targetType === "users") {
    payload.targetUserIds = Array.from(commSelectedUserIds);
  }

  if (confirmBtn) confirmBtn.disabled = true;
  if (confirmText) confirmText.textContent = "Dispatching announcements...";

  let totalSent = 0;
  let totalSkipped = 0;
  const channelsUsed = [];
  const warnings = [];

  try {
    // 1. Primary Channel Dispatch
    if (commActiveChannel === "email") {
      channelsUsed.push("Email");
      const emailFn = functions.httpsCallable("sendAdminBroadcast");
      const emailResult = await emailFn({ ...payload, subject });
      totalSent += emailResult.data?.count || 0;
      totalSkipped += emailResult.data?.skippedCount || 0;
      if (emailResult.data?.warning) warnings.push(emailResult.data.warning);

      if (mirrorActive) {
        channelsUsed.push("WhatsApp");
        const waFn = functions.httpsCallable("sendWhatsAppBroadcast");
        const waResult = await waFn(payload);
        totalSent += waResult.data?.count || 0;
        totalSkipped += waResult.data?.skippedCount || 0;
        if (waResult.data?.warning) warnings.push(waResult.data.warning);
      }
    } else {
      // Primary is WhatsApp
      channelsUsed.push("WhatsApp");
      const waFn = functions.httpsCallable("sendWhatsAppBroadcast");
      const waResult = await waFn(payload);
      totalSent += waResult.data?.count || 0;
      totalSkipped += waResult.data?.skippedCount || 0;
      if (waResult.data?.warning) warnings.push(waResult.data.warning);

      if (mirrorActive) {
        channelsUsed.push("Email");
        const emailFn = functions.httpsCallable("sendAdminBroadcast");
        const fallbackSubject = subject || `${currentFestivalConfig.festivalName || 'Festival'} Announcement`;
        const emailResult = await emailFn({ ...payload, subject: fallbackSubject });
        totalSent += emailResult.data?.count || 0;
        totalSkipped += emailResult.data?.skippedCount || 0;
        if (emailResult.data?.warning) warnings.push(emailResult.data.warning);
      }
    }

    closeCommReviewModal();

    if (totalSent === 0 && totalSkipped > 0) {
      const warnMsg = warnings.length > 0 ? warnings.join(" ") : "All messages were skipped or failed delivery.";
      showBroadcastAlert(`No messages delivered (${totalSkipped} skipped). ${warnMsg}`, false);
    } else if (totalSent > 0) {
      const warnSuffix = warnings.length > 0 ? ` (Note: ${warnings.join(" ")})` : "";
      showBroadcastAlert(`Successfully dispatched announcement to ${totalSent} recipient(s) across ${channelsUsed.join(" & ")}${totalSkipped > 0 ? ` (${totalSkipped} skipped)` : ''}!${warnSuffix}`, true);
    } else {
      showBroadcastAlert("0 recipients matched the selected criteria. No messages were dispatched.", false);
    }

    // Save history audit
    const { targetDesc } = getResolvedCommRecipients();
    commRecentDispatches.unshift({
      timestamp: new Date().toISOString(),
      channels: channelsUsed.join(" & "),
      targetDesc,
      sentCount: totalSent,
      skippedCount: totalSkipped,
      subject: subject || body.substring(0, 40) + "..."
    });
    if (commRecentDispatches.length > 15) commRecentDispatches.pop();
    try {
      localStorage.setItem("brewcrew_comm_history", JSON.stringify(commRecentDispatches));
    } catch (e) {}

    renderCommHistory();

    // Reset inputs
    if (bodyInput) bodyInput.value = "";
    if (subjectInput) subjectInput.value = "";
    handleCommBodyInput();
  } catch (err) {
    console.error("Communication dispatch error:", err);
    showBroadcastAlert("Dispatch failure: " + err.message, false);
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
    if (confirmText) confirmText.textContent = "Confirm & Dispatch Now";
  }
}

/**
 * Renders the recent dispatch audit table
 */
function renderCommHistory() {
  const tbody = document.getElementById("comm-recent-history-tbody");
  if (!tbody) return;

  if (commRecentDispatches.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-4 text-slate-400 italic text-2xs">
          No broadcasts dispatched yet in this session.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = commRecentDispatches.map((h) => {
    const d = new Date(h.timestamp);
    const dateFormatted = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " +
                          d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const channelBadge = h.channels.includes("WhatsApp") && h.channels.includes("Email")
      ? `<span class="px-1.5 py-0.5 rounded text-3xs font-bold bg-amber-100 text-amber-900 border border-amber-300">Omnichannel</span>`
      : h.channels.includes("WhatsApp")
      ? `<span class="px-1.5 py-0.5 rounded text-3xs font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">WhatsApp</span>`
      : `<span class="px-1.5 py-0.5 rounded text-3xs font-bold bg-blue-100 text-blue-900 border border-blue-300">Email</span>`;

    return `
      <tr class="hover:bg-amber-50/40 transition">
        <td class="py-2.5 px-3 whitespace-nowrap text-2xs text-slate-500 font-mono">${dateFormatted}</td>
        <td class="py-2.5 px-3">${channelBadge}</td>
        <td class="py-2.5 px-3 font-semibold text-slate-800 text-2xs truncate max-w-[140px]">${escapeHtml(h.targetDesc || 'All Crew')}</td>
        <td class="py-2.5 px-3 text-center tabular-nums font-bold text-emerald-700">${h.sentCount}</td>
        <td class="py-2.5 px-3 text-center tabular-nums text-slate-400">${h.skippedCount || 0}</td>
        <td class="py-2.5 px-3 text-slate-600 truncate max-w-[200px] text-2xs">${escapeHtml(h.subject || 'Announcement')}</td>
      </tr>
    `;
  }).join("");
}

function showBroadcastAlert(msg, isSuccess) {
  const alertEl = document.getElementById("admin-broadcast-alert");
  if (!alertEl) return;
  alertEl.className = isSuccess
    ? "p-3 rounded-lg text-xs bg-emerald-50 text-emerald-800 border border-emerald-300"
    : "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300";
  alertEl.textContent = msg;
  alertEl.classList.remove("hidden");
  if (isSuccess) {
    setTimeout(() => alertEl.classList.add("hidden"), 8000);
  }
}

function updateBroadcastTargetLabel(target) {
  handleCommTargetTypeChange("role");
  const select = document.getElementById("comm-context-select");
  if (select) select.value = target;
  updateCommTargetPreview();
}

function handleSendAdminBroadcast(e) {
  if (e && e.preventDefault) e.preventDefault();
  openCommReviewModal();
}

// ============================================================================
// MODAL: CREATE / EDIT SHIFT
// ============================================================================
function openCreateShiftModal() {
  const modal = document.getElementById("modal-shift-editor");
  const modalTitle = document.getElementById("shift-editor-modal-title");
  const shiftIdInput = document.getElementById("editor-shift-id");
  const sessionSelect = document.getElementById("editor-shift-session");
  const catInput = document.getElementById("editor-shift-category");
  const capInput = document.getElementById("editor-shift-capacity");
  const startInput = document.getElementById("editor-shift-start");
  const endInput = document.getElementById("editor-shift-end");
  const mgrSelect = document.getElementById("editor-shift-manager");
  const alertEl = document.getElementById("shift-editor-alert");

  if (alertEl) alertEl.classList.add("hidden");
  if (modalTitle) modalTitle.textContent = "Create New Festival Shift";
  if (shiftIdInput) shiftIdInput.value = "";
  if (catInput) catInput.value = "";
  if (capInput) capInput.value = "4";

  // Populate Sessions
  if (sessionSelect) {
    sessionSelect.innerHTML = `<option value="">-- Select Session --</option>`;
    const sessions = currentFestivalConfig.sessions || [];
    sessions.forEach((sess) => {
      const opt = document.createElement("option");
      opt.value = sess.id;
      opt.textContent = `${sess.name} (${sess.date} ${sess.startTime}-${sess.endTime})`;
      sessionSelect.appendChild(opt);
    });
  }

  // Populate Managers
  if (mgrSelect) {
    mgrSelect.innerHTML = `<option value="">-- Unassigned (No Manager) --</option>`;
    allUsersMap.forEach((u) => {
      if (u.role === "manager" || u.role === "admin") {
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = `${u.fullName || 'Manager'} (${u.role})`;
        mgrSelect.appendChild(opt);
      }
    });
  }

  if (startInput) startInput.value = "";
  if (endInput) endInput.value = "";

  if (modal) modal.classList.remove("hidden");
}

function handleEditorSessionChange(sessionId) {
  const session = (currentFestivalConfig.sessions || []).find((s) => s.id === sessionId);
  if (!session) return;

  const startInput = document.getElementById("editor-shift-start");
  const endInput = document.getElementById("editor-shift-end");

  if (session.date && session.startTime && startInput) {
    startInput.value = `${session.date}T${session.startTime}`;
  }
  if (session.date && session.endTime && endInput) {
    endInput.value = `${session.date}T${session.endTime}`;
  }
}

function openEditShiftModal(shiftId) {
  const shiftDoc = currentShiftsDocs.find((d) => d.id === shiftId);
  if (!shiftDoc) return;
  const shift = shiftDoc.data();

  openCreateShiftModal();

  const modalTitle = document.getElementById("shift-editor-modal-title");
  const shiftIdInput = document.getElementById("editor-shift-id");
  const sessionSelect = document.getElementById("editor-shift-session");
  const catInput = document.getElementById("editor-shift-category");
  const capInput = document.getElementById("editor-shift-capacity");
  const startInput = document.getElementById("editor-shift-start");
  const endInput = document.getElementById("editor-shift-end");
  const mgrSelect = document.getElementById("editor-shift-manager");

  if (modalTitle) modalTitle.textContent = "Edit Festival Shift";
  if (shiftIdInput) shiftIdInput.value = shiftId;
  if (sessionSelect && shift.sessionId) sessionSelect.value = shift.sessionId;
  if (catInput) catInput.value = shift.categoryName || "";
  if (capInput) capInput.value = shift.capacity || 4;
  if (mgrSelect && shift.managerId) mgrSelect.value = shift.managerId;

  if (startInput && shift.startTime) {
    startInput.value = formatForDateTimeLocal(shift.startTime);
  }
  if (endInput && shift.endTime) {
    endInput.value = formatForDateTimeLocal(shift.endTime);
  }
}

function closeShiftEditorModal() {
  const modal = document.getElementById("modal-shift-editor");
  if (modal) modal.classList.add("hidden");
}

async function handleShiftEditorSubmit(e) {
  e.preventDefault();
  const shiftId = document.getElementById("editor-shift-id")?.value;
  const sessionId = document.getElementById("editor-shift-session")?.value;
  const categoryName = document.getElementById("editor-shift-category")?.value?.trim();
  const capacity = parseInt(document.getElementById("editor-shift-capacity")?.value, 10);
  const startTime = document.getElementById("editor-shift-start")?.value;
  const endTime = document.getElementById("editor-shift-end")?.value;
  const managerUserId = document.getElementById("editor-shift-manager")?.value || null;
  const alertEl = document.getElementById("shift-editor-alert");
  const submitBtn = document.getElementById("btn-submit-shift-editor");

  if (!sessionId || !categoryName || !capacity || !startTime || !endTime) {
    showModalAlert(alertEl, "Please fill in all mandatory fields.", false);
    return;
  }

  if (submitBtn) submitBtn.disabled = true;

  try {
    if (shiftId) {
      // Edit Shift
      const fn = functions.httpsCallable("updateShift");
      await fn({
        shiftId,
        sessionId,
        categoryName,
        capacity,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString()
      });
      if (managerUserId !== undefined) {
        const mgrFn = functions.httpsCallable("assignShiftManager");
        await mgrFn({ shiftId, managerUserId });
      }
    } else {
      // Create Shift
      const fn = functions.httpsCallable("createShift");
      await fn({
        sessionId,
        categoryName,
        capacity,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        managerUserId
      });
    }
    closeShiftEditorModal();
  } catch (err) {
    showModalAlert(alertEl, err.message || "Failed to save shift.", false);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ============================================================================
// UTILITIES & FORMATTERS
// ============================================================================
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeJs(str) {
  if (!str) return "";
  return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function showModalAlert(el, message, isSuccess) {
  if (!el) return;
  el.className = isSuccess ?
    "p-3 rounded-lg text-xs bg-emerald-50 text-emerald-800 border border-emerald-300" :
    "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300";
  el.textContent = message;
  el.classList.remove("hidden");
}

function getTimestampMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  if (typeof ts._seconds === "number") return ts._seconds * 1000;
  const ms = new Date(ts).getTime();
  return isNaN(ms) ? 0 : ms;
}

function formatTime(ts) {
  const ms = getTimestampMs(ts);
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDate(ts) {
  const ms = getTimestampMs(ts);
  if (!ms) return "";
  return new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function formatTimestamp(ts) {
  const ms = getTimestampMs(ts);
  if (!ms) return "";
  return new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatForDateTimeLocal(ts) {
  const ms = getTimestampMs(ts);
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Universal Keyboard Escape Modal Dismissal
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const modals = [
    { id: "modal-delete-group", close: closeDeleteGroupModal },
    { id: "modal-merge-group", close: closeMergeGroupModal },
    { id: "modal-set-user-group", close: closeSetUserGroupModal },
    { id: "modal-manage-groups", close: closeManageGroupsModal },
    { id: "modal-toggle-disable", close: closeToggleDisableModal },
    { id: "modal-delete-block", close: closeDeleteBlockModal },
    { id: "modal-assign-volunteer", close: closeAssignVolunteerModal },
    { id: "modal-shift-editor", close: closeShiftEditorModal },
    { id: "modal-comm-review", close: closeCommReviewModal }
  ];
  for (const m of modals) {
    const el = document.getElementById(m.id);
    if (el && !el.classList.contains("hidden")) {
      m.close();
      e.preventDefault();
      break;
    }
  }
});

// Global Exports
window.switchAdminTab = switchAdminTab;
window.handleCrewSearch = handleCrewSearch;
window.setCrewRoleFilter = setCrewRoleFilter;
window.setCrewStatusFilter = setCrewStatusFilter;
window.handleCrewSortChange = handleCrewSortChange;
window.handleCrewPageSizeChange = handleCrewPageSizeChange;
window.handleRoleChange = handleRoleChange;
window.setCrewGroupFilter = setCrewGroupFilter;
window.openManageGroupsModal = openManageGroupsModal;
window.closeManageGroupsModal = closeManageGroupsModal;
window.setEditingGroup = setEditingGroup;
window.handleCreateGroup = handleCreateGroup;
window.handleCreateGroupFromName = handleCreateGroupFromName;
window.handleRenameGroup = handleRenameGroup;
window.handleToggleGroupIncentives = handleToggleGroupIncentives;
window.openMergeGroupModal = openMergeGroupModal;
window.closeMergeGroupModal = closeMergeGroupModal;
window.handleMergeGroupSubmit = handleMergeGroupSubmit;
window.openDeleteGroupModal = openDeleteGroupModal;
window.closeDeleteGroupModal = closeDeleteGroupModal;
window.handleDeleteGroupSubmit = handleDeleteGroupSubmit;
window.openSetUserGroupModal = openSetUserGroupModal;
window.closeSetUserGroupModal = closeSetUserGroupModal;
window.handleSetUserGroupSubmit = handleSetUserGroupSubmit;
window.openAdminEditUserModal = openAdminEditUserModal;
window.closeAdminEditUserModal = closeAdminEditUserModal;
window.handleAdminEditUserGroupSelect = handleAdminEditUserGroupSelect;
window.handleAdminEditUserSubmit = handleAdminEditUserSubmit;
window.openToggleDisableModal = openToggleDisableModal;
window.closeToggleDisableModal = closeToggleDisableModal;
window.handleToggleDisableSubmit = handleToggleDisableSubmit;
window.openDeleteBlockModal = openDeleteBlockModal;
window.closeDeleteBlockModal = closeDeleteBlockModal;
window.handleDeleteBlockSubmit = handleDeleteBlockSubmit;
window.handleUnblockEmail = handleUnblockEmail;
window.setShiftsSessionFilter = setShiftsSessionFilter;
window.setAdminShiftDay = setAdminShiftDay;
window.setAdminShiftSession = setAdminShiftSession;
window.setAdminShiftGroupingMode = setAdminShiftGroupingMode;
window.openShiftRosterModal = openShiftRosterModal;
window.closeShiftRosterModal = closeShiftRosterModal;
window.handleAdminUnassignVolunteer = handleAdminUnassignVolunteer;
window.handleDeleteShift = handleDeleteShift;
window.openAssignVolunteerModal = openAssignVolunteerModal;
window.closeAssignVolunteerModal = closeAssignVolunteerModal;
window.handleAssignVolunteerSubmit = handleAssignVolunteerSubmit;
window.openCreateShiftModal = openCreateShiftModal;
window.openEditShiftModal = openEditShiftModal;
window.closeShiftEditorModal = closeShiftEditorModal;
window.handleEditorSessionChange = handleEditorSessionChange;
window.handleShiftEditorSubmit = handleShiftEditorSubmit;
window.previewFestivalLogo = previewFestivalLogo;
window.handleSaveFestivalConfig = handleSaveFestivalConfig;
window.handleAddFestivalSession = handleAddFestivalSession;
window.handleDeleteFestivalSession = handleDeleteFestivalSession;
window.handleAddIncentive = handleAddIncentive;
window.handleDeleteIncentive = handleDeleteIncentive;
window.handleSaveIncentivesConfig = handleSaveIncentivesConfig;
window.openEditRoleModal = openEditRoleModal;
window.updateBroadcastTargetLabel = updateBroadcastTargetLabel;
window.handleSendAdminBroadcast = handleSendAdminBroadcast;
window.switchCommChannel = switchCommChannel;
window.handleCommTargetTypeChange = handleCommTargetTypeChange;
window.handleCommContextChange = handleCommContextChange;
window.filterCommUserList = filterCommUserList;
window.toggleCommUserSelect = toggleCommUserSelect;
window.selectAllCommUsers = selectAllCommUsers;
window.updateCommTargetPreview = updateCommTargetPreview;
window.applyCommStarter = applyCommStarter;
window.insertCommPlaceholder = insertCommPlaceholder;
window.handleCommBodyInput = handleCommBodyInput;
window.updateCommLivePreview = updateCommLivePreview;
window.openCommReviewModal = openCommReviewModal;
window.closeCommReviewModal = closeCommReviewModal;
window.executeCommDispatch = executeCommDispatch;
window.adminSignOut = adminSignOut;
