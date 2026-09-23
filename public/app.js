// Initialize Firebase Config from external firebase-config.js (or window.firebaseConfig)
const firebaseConfig = window.firebaseConfig;

if (!firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("YOUR_")) {
  console.error(
    "BrewCrew Platform Configuration Error: Firebase credentials not found.\n" +
    "Please copy 'public/firebase-config.example.js' to 'public/firebase-config.js' " +
    "and configure your Firebase project credentials."
  );
  alert(
    "Configuration Notice: Firebase credentials are not yet configured.\n" +
    "Please create 'public/firebase-config.js' (see public/firebase-config.example.js)."
  );
}

firebase.initializeApp(firebaseConfig || {});
const auth = firebase.auth();
const db = firebase.firestore();
const functions = firebase.functions();

// Global App State
let currentUser = null;
let currentUserProfile = null;
let currentUserRole = "volunteer";
let userProfileUnsubscribe = null;

let selectedDay = 1;
let selectedCategory = "ALL";
let currentView = "schedule";

// Categories State (Default fallback + dynamic Firestore)
const defaultCategories = ["Cider Bar", "Cask Bar", "Keg Bar", "Token and Merch", "Gate"];
let availableCategories = [...defaultCategories];

// Realtime Registrations & Users Cache & Listeners
const userRegistrations = new Map(); // shiftId -> regData
let shiftsUnsubscribe = null;
let registrationsUnsubscribe = null;
let categoriesUnsubscribe = null;
let currentShiftsDocs = [];

// Admin & Manager State
const allUsersMap = new Map(); // userId -> userProfile
let allUsersUnsubscribe = null;
let adminUserFilterText = "";
let adminRoleFilter = "ALL";
let activeAssignModalShiftId = null;
let activeRosterShiftId = null;

// Expose action functions to window explicitly for HTML onclick handlers
window.switchView = switchView;
window.loginWithGoogle = loginWithGoogle;
window.handleEmailSignIn = handleEmailSignIn;
window.handleEmailSignUp = handleEmailSignUp;
window.handlePasswordReset = handlePasswordReset;
window.showAuthTab = showAuthTab;
window.showAuthSubView = showAuthSubView;
window.togglePasswordVisibility = togglePasswordVisibility;
window.logout = logout;
window.filterCategory = filterCategory;
window.claimShift = claimShift;
window.cancelShift = cancelShift;

// Admin & Manager Window Exports
window.openCreateShiftModal = openCreateShiftModal;
window.closeCreateShiftModal = closeCreateShiftModal;
window.handleCategorySelectChange = handleCategorySelectChange;
window.handleCreateShiftSubmit = handleCreateShiftSubmit;

window.openAssignManagerModal = openAssignManagerModal;
window.closeAssignManagerModal = closeAssignManagerModal;
window.handleSaveManagerAssignment = handleSaveManagerAssignment;

window.managerClaimShift = managerClaimShift;
window.managerUnassignShift = managerUnassignShift;

window.openShiftRosterModal = openShiftRosterModal;
window.closeShiftRosterModal = closeShiftRosterModal;
window.adminCancelUserShift = adminCancelUserShift;

window.handleAdminUserSearch = handleAdminUserSearch;
window.handleAdminRoleFilter = handleAdminRoleFilter;
window.changeUserRole = changeUserRole;

// System Initialization
document.addEventListener("DOMContentLoaded", () => {
  // Bind navigation listeners
  const scheduleBtn = document.getElementById("nav-schedule-btn");
  if (scheduleBtn) {
    scheduleBtn.addEventListener("click", () => switchView("schedule"));
  }
  const myShiftsBtn = document.getElementById("nav-my-shifts-btn");
  if (myShiftsBtn) {
    myShiftsBtn.addEventListener("click", () => switchView("my-shifts"));
  }
  const adminBtn = document.getElementById("nav-admin-btn");
  if (adminBtn) {
    adminBtn.addEventListener("click", () => switchView("admin"));
  }

  // Setup Auth State Listener (Strict Gateway: Interface is completely hidden until authenticated)
  auth.onAuthStateChanged(user => {
    // Hide initial app loading screen
    const appLoading = document.getElementById("app-loading");
    if (appLoading) {
      appLoading.classList.add("hidden");
    }

    const authScreen = document.getElementById("auth-screen");
    const authenticatedApp = document.getElementById("authenticated-app");

    currentUser = user;
    if (user) {
      // 1. Hide Login Screen, Reveal Authenticated Platform
      if (authScreen) {
        authScreen.classList.add("hidden");
        authScreen.classList.remove("flex");
      }
      if (authenticatedApp) {
        authenticatedApp.classList.remove("hidden");
      }

      // 2. Populate Authenticated User Details in Navbar
      const userInfo = document.getElementById("user-info");
      if (userInfo) {
        userInfo.classList.remove("hidden");
        userInfo.classList.add("flex");
      }
      const userNameEl = document.getElementById("user-name");
      if (userNameEl) {
        userNameEl.innerText = user.displayName || user.email;
      }
      const userAvatarEl = document.getElementById("user-avatar");
      if (userAvatarEl) {
        userAvatarEl.src = user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName || user.email || "Volunteer")}&background=b45309&color=fff`;
      }

      // 3. Sync User Profile & Initialize Authenticated Realtime Listeners
      syncUserProfile(user);
      subscribeToCurrentUserProfile(user.uid);
      subscribeToUserRegistrations(user.uid);
      initCategoryListener();
      renderDayTabs();
      renderCategoryFilters();
      subscribeToShifts();
      initRoute();
    } else {
      // Unauthenticated State: Ensure interface is NOT loaded and only login prompt is visible
      currentUserProfile = null;
      currentUserRole = "volunteer";

      // 1. Hide Authenticated App, Show Login Prompt Screen
      if (authenticatedApp) {
        authenticatedApp.classList.add("hidden");
      }
      if (authScreen) {
        authScreen.classList.remove("hidden");
        authScreen.classList.add("flex");
      }

      // 2. Teardown All Realtime Listeners to Protect Data and Prevent Permission Denied Errors
      if (userProfileUnsubscribe) {
        userProfileUnsubscribe();
        userProfileUnsubscribe = null;
      }
      if (allUsersUnsubscribe) {
        allUsersUnsubscribe();
        allUsersUnsubscribe = null;
      }
      if (registrationsUnsubscribe) {
        registrationsUnsubscribe();
        registrationsUnsubscribe = null;
      }
      if (shiftsUnsubscribe) {
        shiftsUnsubscribe();
        shiftsUnsubscribe = null;
      }
      if (categoriesUnsubscribe) {
        categoriesUnsubscribe();
        categoriesUnsubscribe = null;
      }

      allUsersMap.clear();
      userRegistrations.clear();
      currentShiftsDocs = [];

      // 3. Clear Auth Form Inputs & Alerts
      clearAuthAlerts();
      const signinForm = document.getElementById("form-signin");
      if (signinForm) signinForm.reset();
      const registerForm = document.getElementById("form-register");
      if (registerForm) registerForm.reset();
      const forgotForm = document.getElementById("form-forgot-password");
      if (forgotForm) forgotForm.reset();
      showAuthSubView("tabs");
    }
  });
});

// View Routing
function initRoute() {
  const hash = window.location.hash;
  if (hash === "#my-shifts" || window.location.pathname.endsWith("/my-shifts")) {
    switchView("my-shifts");
  } else if (hash === "#admin" && currentUserRole === "admin") {
    switchView("admin");
  } else {
    switchView("schedule");
  }

  window.addEventListener("hashchange", () => {
    if (!currentUser) return;
    if (window.location.hash === "#my-shifts") {
      switchView("my-shifts");
    } else if (window.location.hash === "#admin") {
      if (currentUserRole === "admin") {
        switchView("admin");
      } else {
        switchView("schedule");
      }
    } else {
      switchView("schedule");
    }
  });
}

function switchView(viewName) {
  if (viewName === "admin" && currentUserRole !== "admin") {
    viewName = "schedule";
  }
  currentView = viewName;

  const scheduleView = document.getElementById("view-schedule");
  const myShiftsView = document.getElementById("view-my-shifts");
  const adminView = document.getElementById("view-admin");

  const navScheduleBtn = document.getElementById("nav-schedule-btn");
  const navMyShiftsBtn = document.getElementById("nav-my-shifts-btn");
  const navAdminBtn = document.getElementById("nav-admin-btn");

  const activeClass = "px-3.5 py-1.5 rounded-md text-sm font-semibold transition bg-amber-700 text-white shadow-sm flex items-center";
  const inactiveClass = "px-3.5 py-1.5 rounded-md text-sm font-semibold transition text-amber-200 hover:text-white flex items-center";

  if (scheduleView) scheduleView.classList.add("hidden");
  if (myShiftsView) myShiftsView.classList.add("hidden");
  if (adminView) adminView.classList.add("hidden");

  if (navScheduleBtn) navScheduleBtn.className = inactiveClass;
  if (navMyShiftsBtn) navMyShiftsBtn.className = inactiveClass;
  if (navAdminBtn) navAdminBtn.className = inactiveClass;

  if (viewName === "my-shifts") {
    if (myShiftsView) myShiftsView.classList.remove("hidden");
    if (navMyShiftsBtn) navMyShiftsBtn.className = activeClass;
    if (window.location.hash !== "#my-shifts") {
      window.location.hash = "#my-shifts";
    }
  } else if (viewName === "admin") {
    if (adminView) adminView.classList.remove("hidden");
    if (navAdminBtn) navAdminBtn.className = activeClass;
    if (window.location.hash !== "#admin") {
      window.location.hash = "#admin";
    }
    renderAdminUsers();
  } else {
    if (scheduleView) scheduleView.classList.remove("hidden");
    if (navScheduleBtn) navScheduleBtn.className = activeClass;
    if (window.location.hash !== "#schedule") {
      window.location.hash = "#schedule";
    }
  }
}

// Authentication & Credential Management
function loginWithGoogle() {
  const googleBtn = document.getElementById("google-signin-btn");
  const googleBtnText = document.getElementById("google-btn-text");
  if (googleBtnText) googleBtnText.innerText = "Signing in...";
  if (googleBtn) googleBtn.disabled = true;
  clearAuthAlerts();

  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider)
    .catch(err => {
      if (err.code !== "auth/popup-closed-by-user") {
        showAuthAlert("signin-alert", getFriendlyAuthErrorMessage(err));
      }
    })
    .finally(() => {
      if (googleBtnText) googleBtnText.innerText = "Sign In with Google";
      if (googleBtn) googleBtn.disabled = false;
    });
}

async function handleEmailSignIn(event) {
  event.preventDefault();
  clearAuthAlerts();

  const emailInput = document.getElementById("signin-email");
  const passwordInput = document.getElementById("signin-password");
  const submitBtn = document.getElementById("btn-submit-signin");
  const submitText = document.getElementById("btn-signin-text");

  const email = emailInput?.value?.trim();
  const password = passwordInput?.value;

  if (!email || !password) {
    showAuthAlert("signin-alert", "Please enter both email and password.");
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.innerText = "Signing in...";

  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    console.error("Sign in error:", err);
    showAuthAlert("signin-alert", getFriendlyAuthErrorMessage(err));
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.innerText = "Sign In with Email";
  }
}

async function handleEmailSignUp(event) {
  event.preventDefault();
  clearAuthAlerts();

  const nameInput = document.getElementById("register-name");
  const emailInput = document.getElementById("register-email");
  const passwordInput = document.getElementById("register-password");
  const confirmPasswordInput = document.getElementById("register-confirm-password");
  const submitBtn = document.getElementById("btn-submit-register");
  const submitText = document.getElementById("btn-register-text");

  const fullName = nameInput?.value?.trim();
  const email = emailInput?.value?.trim();
  const password = passwordInput?.value;
  const confirmPassword = confirmPasswordInput?.value;

  if (!fullName) {
    showAuthAlert("register-alert", "Please enter your full name.");
    return;
  }
  if (!email) {
    showAuthAlert("register-alert", "Please enter a valid email address.");
    return;
  }
  if (!password || password.length < 6) {
    showAuthAlert("register-alert", "Password must be at least 6 characters.");
    return;
  }
  if (password !== confirmPassword) {
    showAuthAlert("register-alert", "Passwords do not match. Please re-enter.");
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.innerText = "Creating account...";

  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    const user = cred.user;

    // Update Auth profile displayName
    await user.updateProfile({
      displayName: fullName
    });

    // Create user profile in Firestore
    await db.collection("users").doc(user.uid).set({
      fullName: fullName,
      email: email.toLowerCase(),
      role: "volunteer",
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error("Registration error:", err);
    showAuthAlert("register-alert", getFriendlyAuthErrorMessage(err));
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.innerText = "Create Volunteer Account";
  }
}

async function handlePasswordReset(event) {
  event.preventDefault();
  clearAuthAlerts();

  const emailInput = document.getElementById("forgot-email");
  const submitBtn = document.getElementById("btn-submit-forgot");
  const submitText = document.getElementById("btn-forgot-text");

  const email = emailInput?.value?.trim();
  if (!email) {
    showAuthAlert("forgot-alert", "Please enter your account email address.");
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.innerText = "Sending reset link...";

  try {
    await auth.sendPasswordResetEmail(email.toLowerCase());
    showAuthAlert("forgot-alert", "Password reset email sent! Check your inbox for instructions.", true);
    if (emailInput) emailInput.value = "";
  } catch (err) {
    console.error("Password reset error:", err);
    showAuthAlert("forgot-alert", getFriendlyAuthErrorMessage(err));
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.innerText = "Send Password Reset Link";
  }
}

function showAuthTab(tab) {
  const tabBtnSignIn = document.getElementById("tab-btn-signin");
  const tabBtnRegister = document.getElementById("tab-btn-register");
  const formSignIn = document.getElementById("form-signin");
  const formRegister = document.getElementById("form-register");
  
  clearAuthAlerts();

  if (tab === "register") {
    if (tabBtnRegister) tabBtnRegister.className = "flex-1 py-1.5 text-xs font-bold rounded-md bg-white text-slate-800 shadow-sm transition";
    if (tabBtnSignIn) tabBtnSignIn.className = "flex-1 py-1.5 text-xs font-bold rounded-md text-slate-500 hover:text-slate-800 transition";
    if (formSignIn) formSignIn.classList.add("hidden");
    if (formRegister) formRegister.classList.remove("hidden");
  } else {
    if (tabBtnSignIn) tabBtnSignIn.className = "flex-1 py-1.5 text-xs font-bold rounded-md bg-white text-slate-800 shadow-sm transition";
    if (tabBtnRegister) tabBtnRegister.className = "flex-1 py-1.5 text-xs font-bold rounded-md text-slate-500 hover:text-slate-800 transition";
    if (formRegister) formRegister.classList.add("hidden");
    if (formSignIn) formSignIn.classList.remove("hidden");
  }
}

function showAuthSubView(view) {
  const mainView = document.getElementById("auth-main-view");
  const forgotView = document.getElementById("auth-forgot-view");
  clearAuthAlerts();

  if (view === "forgot") {
    if (mainView) mainView.classList.add("hidden");
    if (forgotView) forgotView.classList.remove("hidden");
  } else {
    if (forgotView) forgotView.classList.add("hidden");
    if (mainView) mainView.classList.remove("hidden");
  }
}

function togglePasswordVisibility(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input) return;

  if (input.type === "password") {
    input.type = "text";
    if (btn) btn.innerText = "🙈";
  } else {
    input.type = "password";
    if (btn) btn.innerText = "👁️";
  }
}

function showAuthAlert(containerId, message, isSuccess = false) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.classList.remove("hidden");
  if (isSuccess) {
    el.className = "p-3 rounded-lg text-xs font-medium bg-emerald-50 text-emerald-800 border border-emerald-300";
    el.innerHTML = `✓ ${message}`;
  } else {
    el.className = "p-3 rounded-lg text-xs font-medium bg-rose-50 text-rose-800 border border-rose-300";
    el.innerHTML = `⚠️ ${message}`;
  }
}

function clearAuthAlerts() {
  ["signin-alert", "register-alert", "forgot-alert"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add("hidden");
      el.innerText = "";
    }
  });
}

function getFriendlyAuthErrorMessage(error) {
  if (!error) return "An unexpected error occurred. Please try again.";
  switch (error.code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
      return "Incorrect email or password. Please verify your credentials.";
    case "auth/user-not-found":
      return "No account found with this email. Please register or check for typos.";
    case "auth/email-already-in-use":
      return "An account with this email address already exists. Try signing in, or use Google Sign-In if you previously used Google.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/too-many-requests":
      return "Access temporarily disabled due to many failed attempts. You can reset your password or try again later.";
    case "auth/network-request-failed":
      return "Network connection issue. Please check your internet connection.";
    case "auth/popup-closed-by-user":
      return "Sign in cancelled by user.";
    default:
      return error.message || "Authentication failed.";
  }
}

function logout() {
  auth.signOut().catch(err => console.error("Sign out error:", err));
}

async function syncUserProfile(user) {
  try {
    const userRef = db.collection("users").doc(user.uid);
    const doc = await userRef.get();
    if (!doc.exists) {
      await userRef.set({
        fullName: user.displayName || "Volunteer",
        email: user.email,
        role: "volunteer",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } else {
      const data = doc.data();
      if ((!data.fullName || data.fullName === "Volunteer") && user.displayName) {
        await userRef.update({
          fullName: user.displayName
        });
      }
    }
  } catch (err) {
    console.error("Error syncing user profile:", err);
  }
}

function subscribeToCurrentUserProfile(uid) {
  if (userProfileUnsubscribe) {
    userProfileUnsubscribe();
  }

  userProfileUnsubscribe = db.collection("users").doc(uid).onSnapshot(doc => {
    if (doc.exists) {
      currentUserProfile = doc.data();
      currentUserRole = currentUserProfile.role || "volunteer";
    } else {
      currentUserProfile = null;
      currentUserRole = "volunteer";
    }

    updateRoleUI();

    if (currentUserRole === "admin") {
      subscribeToAllUsers();
    } else if (currentUserRole === "manager") {
      subscribeToAllUsers();
    }

    renderShifts(currentShiftsDocs);

    if (currentView === "admin" && currentUserRole !== "admin") {
      switchView("schedule");
    }
  }, err => {
    console.error("Error subscribing to user profile:", err);
  });
}

function updateRoleUI() {
  const roleBadge = document.getElementById("user-role-badge");
  const navAdminBtn = document.getElementById("nav-admin-btn");
  const adminScheduleBar = document.getElementById("admin-schedule-bar");

  if (currentUser) {
    if (roleBadge) {
      roleBadge.classList.remove("hidden");
      if (currentUserRole === "admin") {
        roleBadge.className = "text-[10px] font-bold px-1.5 py-0.5 rounded w-fit uppercase tracking-wider bg-purple-100 text-purple-900 border border-purple-300";
        roleBadge.innerText = "👑 Admin";
      } else if (currentUserRole === "manager") {
        roleBadge.className = "text-[10px] font-bold px-1.5 py-0.5 rounded w-fit uppercase tracking-wider bg-blue-100 text-blue-900 border border-blue-300";
        roleBadge.innerText = "👔 Manager";
      } else {
        roleBadge.className = "text-[10px] font-bold px-1.5 py-0.5 rounded w-fit uppercase tracking-wider bg-amber-100 text-amber-900 border border-amber-300";
        roleBadge.innerText = "🤝 Volunteer";
      }
    }
  } else {
    if (roleBadge) roleBadge.classList.add("hidden");
  }

  if (currentUserRole === "admin") {
    if (navAdminBtn) {
      navAdminBtn.classList.remove("hidden");
      navAdminBtn.classList.add("flex");
    }
    if (adminScheduleBar) {
      adminScheduleBar.classList.remove("hidden");
      adminScheduleBar.classList.add("flex");
    }
  } else {
    if (navAdminBtn) {
      navAdminBtn.classList.add("hidden");
      navAdminBtn.classList.remove("flex");
    }
    if (adminScheduleBar) {
      adminScheduleBar.classList.add("hidden");
      adminScheduleBar.classList.remove("flex");
    }
  }
}

// All Users Directory (For Admin Role Management and Manager Dropdown)
function subscribeToAllUsers() {
  if (allUsersUnsubscribe) return;

  allUsersUnsubscribe = db.collection("users").onSnapshot(snapshot => {
    allUsersMap.clear();
    snapshot.docs.forEach(doc => {
      allUsersMap.set(doc.id, { id: doc.id, ...doc.data() });
    });
    renderAdminUsers();
    populateManagerDropdowns();
  }, err => {
    console.warn("All users listener error:", err);
  });
}

function populateManagerDropdowns() {
  const newShiftSelect = document.getElementById("new-shift-manager");
  const assignSelect = document.getElementById("assign-manager-select");

  const managerUsers = [];
  allUsersMap.forEach((user, uid) => {
    if (user.role === "manager" || user.role === "admin") {
      managerUsers.push({ id: uid, ...user });
    }
  });

  managerUsers.sort((a, b) => {
    const nameA = (a.fullName || a.email || "").toLowerCase();
    const nameB = (b.fullName || b.email || "").toLowerCase();
    return nameA.localeCompare(nameB);
  });

  const optionsHtml = `
    <option value="">-- None / Assigned On-Site --</option>
    ${managerUsers.map(u => `
      <option value="${u.id}">${escapeHtml(u.fullName || "User")} (${escapeHtml(u.email || "")}) [${u.role === 'admin' ? '👑 Admin' : '👔 Manager'}]</option>
    `).join("")}
  `;

  if (newShiftSelect) {
    const curVal = newShiftSelect.value;
    newShiftSelect.innerHTML = optionsHtml;
    newShiftSelect.value = curVal;
  }

  if (assignSelect) {
    const curVal = assignSelect.value;
    assignSelect.innerHTML = optionsHtml;
    assignSelect.value = curVal;
  }
}

// Categories Dynamic Loading
function initCategoryListener() {
  categoriesUnsubscribe = db.collection("categories").onSnapshot(snapshot => {
    if (!snapshot.empty) {
      const cats = snapshot.docs.map(doc => doc.data().name).filter(Boolean);
      if (cats.length > 0) {
        availableCategories = cats;
        renderCategoryFilters();
      }
    }
  }, err => {
    console.warn("Categories listener error, using defaults:", err);
  });
}

function renderCategoryFilters() {
  const container = document.getElementById("category-filters");
  if (!container) return;

  container.innerHTML = `
    <button onclick="filterCategory('ALL')" class="px-3 py-1 rounded-full text-xs font-semibold transition ${
      selectedCategory === 'ALL' ? 'bg-slate-800 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
    }">
      All Areas
    </button>
  `;

  availableCategories.forEach(cat => {
    const btn = document.createElement("button");
    btn.className = `px-3 py-1 rounded-full text-xs font-semibold transition ${
      selectedCategory === cat ? 'bg-slate-800 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
    }`;
    btn.innerText = cat;
    btn.onclick = () => filterCategory(cat);
    container.appendChild(btn);
  });
}

function filterCategory(cat) {
  selectedCategory = cat;
  renderCategoryFilters();
  renderShifts(currentShiftsDocs);
}

// Day Tabs
function renderDayTabs() {
  const container = document.getElementById("day-tabs");
  if (!container) return;

  container.innerHTML = "";
  for (let i = 1; i <= 7; i++) {
    const btn = document.createElement("button");
    btn.className = `px-4 py-2 rounded-t-lg text-sm font-bold whitespace-nowrap transition ${
      selectedDay === i
        ? "bg-amber-800 text-white shadow-sm"
        : "bg-white text-amber-900 border border-amber-200 hover:bg-amber-100"
    }`;
    btn.innerText = `Day ${i}`;
    btn.onclick = () => {
      selectedDay = i;
      renderDayTabs();
      subscribeToShifts();
    };
    container.appendChild(btn);
  }
}

// Real-Time Shifts Listener
function subscribeToShifts() {
  if (shiftsUnsubscribe) {
    shiftsUnsubscribe();
  }

  const grid = document.getElementById("shifts-grid");
  if (grid) {
    grid.innerHTML = "<p class='text-slate-500 italic col-span-full'>Loading shifts for Day " + selectedDay + "...</p>";
  }

  shiftsUnsubscribe = db.collection("shifts")
    .where("dayIndex", "==", selectedDay)
    .onSnapshot(snapshot => {
      currentShiftsDocs = snapshot.docs;
      renderShifts(currentShiftsDocs);
    }, err => {
      console.error("Error listening to shifts:", err);
      if (grid) {
        grid.innerHTML = "<p class='text-rose-500 col-span-full'>Failed to load shifts: " + err.message + "</p>";
      }
    });
}

// Render Schedule Grid
function renderShifts(docs) {
  const grid = document.getElementById("shifts-grid");
  if (!grid) return;

  if (!docs || docs.length === 0) {
    grid.innerHTML = "<p class='text-slate-500 italic col-span-full'>No shifts scheduled for Day " + selectedDay + ".</p>";
    return;
  }

  const filteredDocs = docs.filter(doc => {
    const shift = doc.data();
    return selectedCategory === "ALL" || shift.categoryName === selectedCategory;
  });

  if (filteredDocs.length === 0) {
    grid.innerHTML = `<p class='text-slate-500 italic col-span-full'>No shifts found under "${selectedCategory}" for Day ${selectedDay}.</p>`;
    return;
  }

  grid.innerHTML = "";

  filteredDocs.forEach(doc => {
    const shift = doc.data();
    const isRegistered = userRegistrations.has(doc.id);
    const isFull = (shift.assignedCount || 0) >= (shift.capacity || 0);
    const isLocked = isShiftLocked(shift.startTime);

    const startTime = formatTime(shift.startTime);
    const endTime = formatTime(shift.endTime);

    const card = document.createElement("div");
    card.className = `bg-white p-5 rounded-xl shadow-sm border transition flex flex-col justify-between ${
      isRegistered ? 'border-emerald-400 ring-2 ring-emerald-200' : 'border-amber-200'
    }`;

    // Manager Section & Actions
    const hasManager = Boolean(shift.managerId);
    const isUserAssignedManager = currentUser && shift.managerId === currentUser.uid;

    let managerText = `<span class="italic text-slate-500">Unassigned (On-Site)</span>`;
    if (shift.managerName) {
      managerText = `<span class="font-semibold text-slate-800">${escapeHtml(shift.managerName)}</span>`;
      if (isUserAssignedManager) {
        managerText += ` <span class="bg-blue-100 text-blue-800 text-[10px] font-bold px-1.5 py-0.5 rounded">You</span>`;
      }
    }

    let managerActionHtml = "";
    if (currentUserRole === "admin") {
      // Requirement E: Admins can assign manager users to shifts
      managerActionHtml = `
        <button onclick="openAssignManagerModal('${doc.id}')" class="text-[11px] font-semibold text-amber-800 hover:text-amber-950 bg-amber-50 hover:bg-amber-100 border border-amber-300 px-2.5 py-1 rounded-md transition shadow-xs flex items-center gap-1">
          ⚙️ ${hasManager ? 'Change Manager' : 'Assign Manager'}
        </button>
      `;
    } else if (currentUserRole === "manager") {
      // Requirement D: Managers can assign themselves (only one manager can be assigned per shift)
      if (!hasManager) {
        managerActionHtml = `
          <button onclick="managerClaimShift('${doc.id}')" class="text-[11px] font-semibold text-blue-700 hover:text-blue-900 bg-blue-50 hover:bg-blue-100 border border-blue-300 px-2.5 py-1 rounded-md transition shadow-xs flex items-center gap-1">
            👔 Assign Myself as Manager
          </button>
        `;
      } else if (isUserAssignedManager) {
        managerActionHtml = `
          <button onclick="managerUnassignShift('${doc.id}')" class="text-[11px] font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-300 px-2 py-0.5 rounded-md transition">
            Step Down
          </button>
        `;
      }
    }

    const managerSectionHtml = `
      <div class="mt-2.5 pt-2.5 border-t border-slate-100 flex flex-wrap justify-between items-center gap-2">
        <p class="text-xs text-slate-600"><strong>Manager:</strong> ${managerText}</p>
        ${managerActionHtml}
      </div>
    `;

    // Requirement B: Admin (and Manager) Shift Roster Inspection & User Cancellation
    let rosterSectionHtml = "";
    if (currentUserRole === "admin" || currentUserRole === "manager") {
      const bookedCount = shift.assignedCount || 0;
      if (bookedCount > 0) {
        rosterSectionHtml = `
          <div class="mt-2 pt-2 border-t border-slate-100 flex justify-between items-center text-xs">
            <span class="text-slate-500 font-medium">Volunteers Booked: ${bookedCount}</span>
            <button onclick="openShiftRosterModal('${doc.id}')" class="text-amber-800 hover:text-amber-950 font-bold underline flex items-center gap-1">
              👥 View Roster &bull; Manage
            </button>
          </div>
        `;
      } else {
        rosterSectionHtml = `
          <div class="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-400 italic">
            No volunteers booked yet
          </div>
        `;
      }
    }

    // Determine Action Button & Badges for Volunteer Registration
    let actionBtnHtml = "";
    if (!currentUser) {
      actionBtnHtml = `
        <button disabled class="mt-4 w-full py-2.5 rounded-lg text-sm font-bold text-slate-400 bg-slate-200 cursor-not-allowed">
          Sign In to Register
        </button>
      `;
    } else if (isRegistered) {
      if (isLocked) {
        actionBtnHtml = `
          <button disabled class="mt-4 w-full py-2.5 rounded-lg text-xs font-bold text-slate-500 bg-slate-200 cursor-not-allowed">
            🔒 Registered &bull; Locked (&lt; 7 Days)
          </button>
        `;
      } else {
        actionBtnHtml = `
          <button onclick="cancelShift('${doc.id}')" class="mt-4 w-full py-2.5 rounded-lg text-sm font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-300 transition shadow-sm">
            Cancel Registration
          </button>
        `;
      }
    } else if (isFull) {
      actionBtnHtml = `
        <button disabled class="mt-4 w-full py-2.5 rounded-lg text-sm font-bold text-slate-400 bg-slate-200 cursor-not-allowed">
          Shift Full
        </button>
      `;
    } else {
      actionBtnHtml = `
        <button onclick="claimShift('${doc.id}')" class="mt-4 w-full py-2.5 rounded-lg text-sm font-bold text-white bg-amber-700 hover:bg-amber-600 transition shadow-sm">
          Register for Shift
        </button>
      `;
    }

    card.innerHTML = `
      <div>
        <div class="flex justify-between items-start mb-2.5">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="bg-amber-100 text-amber-900 text-xs font-bold px-2 py-0.5 rounded">${escapeHtml(shift.categoryName || 'Bar Area')}</span>
            ${isRegistered ? '<span class="bg-emerald-100 text-emerald-800 text-xs font-bold px-2 py-0.5 rounded flex items-center gap-1">✓ Booked</span>' : ''}
          </div>
          <span class="text-xs font-semibold ${isFull && !isRegistered ? 'text-rose-600' : 'text-slate-500'}">
            ${shift.assignedCount || 0} / ${shift.capacity || 0} Filled
          </span>
        </div>
        <h3 class="font-bold text-lg text-slate-800">${startTime} &ndash; ${endTime}</h3>
        ${managerSectionHtml}
        ${rosterSectionHtml}
      </div>
      ${actionBtnHtml}
    `;
    grid.appendChild(card);
  });
}

// Real-Time Registrations Listener
function subscribeToUserRegistrations(uid) {
  if (registrationsUnsubscribe) {
    registrationsUnsubscribe();
  }

  registrationsUnsubscribe = db.collection("registrations")
    .where("userId", "==", uid)
    .where("status", "==", "confirmed")
    .onSnapshot(async snapshot => {
      userRegistrations.clear();
      snapshot.docs.forEach(doc => {
        const data = doc.data();
        userRegistrations.set(data.shiftId, data);
      });

      // Update incentive calculation and My Shifts view
      await updateIncentiveAndMyShifts();

      // Re-render schedule grid to reflect updated registered badges
      renderShifts(currentShiftsDocs);
    }, err => {
      console.error("Error listening to registrations:", err);
    });
}

// Incentive Progress & My Shifts List
async function updateIncentiveAndMyShifts() {
  const listContainer = document.getElementById("my-shifts-list");
  const countBadge = document.getElementById("my-shifts-count");
  const regCount = userRegistrations.size;

  if (countBadge) {
    if (regCount > 0) {
      countBadge.innerText = regCount;
      countBadge.classList.remove("hidden");
    } else {
      countBadge.classList.add("hidden");
    }
  }

  if (!currentUser) {
    document.getElementById("progress-bar").style.width = "0%";
    document.getElementById("hours-badge").innerText = "0 / 8 Hours";
    document.getElementById("incentive-status").innerText =
      "Please sign in to view earned rewards.";
    if (listContainer) {
      listContainer.innerHTML = `
        <div class="text-center py-8">
          <p class="text-slate-500 mb-3">Please sign in to view and manage your registered shifts.</p>
        </div>
      `;
    }
    return;
  }

  if (regCount === 0) {
    document.getElementById("progress-bar").style.width = "0%";
    document.getElementById("hours-badge").innerText = "0 / 8 Hours";
    document.getElementById("incentive-status").innerText =
      "No shifts booked yet. Book 4 hours for a Free Entry Pass, or 8 hours for Entry + T-Shirt!";
    if (listContainer) {
      listContainer.innerHTML = `
        <div class="text-center py-8 bg-amber-50/50 rounded-lg border border-dashed border-amber-300">
          <span class="text-3xl block mb-2">📋</span>
          <p class="text-slate-700 font-semibold mb-1">No shifts booked yet</p>
          <p class="text-slate-500 text-xs mb-4">Browse the festival schedule to pick shifts that match your availability.</p>
          <button onclick="switchView('schedule')" class="bg-amber-700 hover:bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-semibold transition shadow-sm">
            Explore Schedule
          </button>
        </div>
      `;
    }
    return;
  }

  // Fetch registered shifts concurrently
  const shiftIds = Array.from(userRegistrations.keys());
  const shiftDocs = await Promise.all(shiftIds.map(id => db.collection("shifts").doc(id).get()));

  let totalHours = 0;
  const userShifts = [];

  shiftDocs.forEach(shiftDoc => {
    if (shiftDoc.exists) {
      const data = shiftDoc.data();
      const startMs = getShiftStartTimeMs(data.startTime);
      const endMs = getShiftStartTimeMs(data.endTime);
      const durationHours = Math.max(0, Math.round(((endMs - startMs) / (1000 * 3600)) * 10) / 10);
      totalHours += durationHours;
      userShifts.push({ id: shiftDoc.id, ...data, durationHours });
    }
  });

  // Sort shifts chronologically by dayIndex, then startTime
  userShifts.sort((a, b) => {
    if (a.dayIndex !== b.dayIndex) return (a.dayIndex || 0) - (b.dayIndex || 0);
    return getShiftStartTimeMs(a.startTime) - getShiftStartTimeMs(b.startTime);
  });

  // Update Progress Bar
  const percentage = Math.min((totalHours / 8) * 100, 100);
  document.getElementById("progress-bar").style.width = `${percentage}%`;
  document.getElementById("hours-badge").innerText = `${totalHours} / 8 Hours`;

  let statusText = `Total Hours Registered: ${totalHours} hrs. `;
  if (totalHours >= 8) {
    statusText += "🎉 Unlocked: Free Festival Entry Pass + Volunteer T-Shirt!";
  } else if (totalHours >= 4) {
    statusText += `🎉 Unlocked: Free Festival Entry Pass! (Book ${8 - totalHours} more hours for a T-Shirt)`;
  } else {
    statusText += `Book ${4 - totalHours} more hours to unlock your Free Entry Pass.`;
  }
  document.getElementById("incentive-status").innerText = statusText;

  // Render My Shifts List
  if (listContainer) {
    listContainer.innerHTML = "";
    userShifts.forEach(shift => {
      const isLocked = isShiftLocked(shift.startTime);
      const card = document.createElement("div");
      card.className = "border border-amber-200 rounded-lg p-4 bg-amber-50/40 hover:bg-amber-50/80 transition flex flex-col sm:flex-row sm:items-center justify-between gap-3";
      card.innerHTML = `
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="bg-amber-800 text-white text-xs font-bold px-2 py-0.5 rounded">Day ${shift.dayIndex || 1}</span>
            <span class="bg-amber-100 text-amber-900 text-xs font-semibold px-2 py-0.5 rounded">${escapeHtml(shift.categoryName || 'Bar Area')}</span>
            <span class="text-xs text-slate-500 font-medium">${shift.durationHours} hrs</span>
          </div>
          <h4 class="font-bold text-slate-800 text-base">
            ${formatDate(shift.startTime)} &bull; ${formatTime(shift.startTime)} &ndash; ${formatTime(shift.endTime)}
          </h4>
          <p class="text-xs text-slate-500 mt-0.5">
            Manager: <span class="text-slate-700 font-medium">${escapeHtml(shift.managerName || 'Assigned On-Site')}</span>
          </p>
        </div>
        <div class="flex sm:flex-col items-end gap-1.5">
          ${isLocked ? `
            <span class="inline-flex items-center text-xs font-semibold px-3 py-1.5 rounded bg-slate-200 text-slate-600 cursor-not-allowed" title="Shifts cannot be cancelled within 7 days of start time">
              🔒 Locked (&lt; 7 Days)
            </span>
          ` : `
            <button onclick="cancelShift('${shift.id}')" class="text-xs font-semibold px-3 py-1.5 rounded-lg bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 transition shadow-sm">
              Cancel Shift
            </button>
          `}
        </div>
      `;
      listContainer.appendChild(card);
    });
  }
}

// Volunteer Shift Actions
async function claimShift(shiftId) {
  if (!currentUser) {
    return;
  }

  try {
    const claimFn = functions.httpsCallable("claimShift");
    await claimFn({ shiftId: shiftId });
    alert("Successfully registered for shift!");
  } catch (err) {
    alert("Registration failed: " + err.message);
  }
}

async function cancelShift(shiftId) {
  if (!currentUser) {
    alert("Please sign in to manage shifts.");
    return;
  }

  if (!confirm("Are you sure you want to cancel this shift registration?")) {
    return;
  }

  try {
    const cancelFn = functions.httpsCallable("cancelShift");
    await cancelFn({ shiftId: shiftId });
    alert("Successfully cancelled shift registration.");
  } catch (err) {
    alert("Cancellation failed: " + err.message);
  }
}

// ============================================================================
// REQUIREMENT A: Create New Shifts (Admin)
// ============================================================================
function openCreateShiftModal() {
  const modal = document.getElementById("create-shift-modal");
  const daySelect = document.getElementById("new-shift-day");
  const catSelect = document.getElementById("new-shift-category");
  const customCatInput = document.getElementById("new-shift-custom-category");
  const capInput = document.getElementById("new-shift-capacity");
  const startInput = document.getElementById("new-shift-start");
  const endInput = document.getElementById("new-shift-end");
  const mgrSelect = document.getElementById("new-shift-manager");

  daySelect.value = selectedDay;
  capInput.value = "4";
  customCatInput.value = "";
  customCatInput.classList.add("hidden");

  // Populate Categories
  catSelect.innerHTML = availableCategories.map(cat => `
    <option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>
  `).join("") + `<option value="__custom__">➕ Other / Custom Area...</option>`;

  populateManagerDropdowns();
  mgrSelect.value = "";

  // Set default datetime: try inheriting date from existing shift on selectedDay
  let baseDate = new Date();
  const dayShifts = currentShiftsDocs.filter(d => (d.data().dayIndex || 1) === selectedDay);
  if (dayShifts.length > 0 && dayShifts[0].data().startTime) {
    const sampleMs = getShiftStartTimeMs(dayShifts[0].data().startTime);
    if (sampleMs) baseDate = new Date(sampleMs);
  }

  const startDate = new Date(baseDate);
  startDate.setHours(12, 0, 0, 0);
  const endDate = new Date(baseDate);
  endDate.setHours(16, 0, 0, 0);

  startInput.value = formatForDateTimeLocal(startDate);
  endInput.value = formatForDateTimeLocal(endDate);

  modal.classList.remove("hidden");
}

function closeCreateShiftModal() {
  document.getElementById("create-shift-modal").classList.add("hidden");
}

function handleCategorySelectChange(val) {
  const customInput = document.getElementById("new-shift-custom-category");
  if (val === "__custom__") {
    customInput.classList.remove("hidden");
    customInput.focus();
  } else {
    customInput.classList.add("hidden");
  }
}

async function handleCreateShiftSubmit(event) {
  event.preventDefault();

  const dayIndex = parseInt(document.getElementById("new-shift-day").value, 10);
  let categoryName = document.getElementById("new-shift-category").value;
  if (categoryName === "__custom__") {
    categoryName = document.getElementById("new-shift-custom-category").value.trim();
  }
  const capacity = parseInt(document.getElementById("new-shift-capacity").value, 10);
  const startVal = document.getElementById("new-shift-start").value;
  const endVal = document.getElementById("new-shift-end").value;
  const managerUserId = document.getElementById("new-shift-manager").value || null;
  const submitBtn = document.getElementById("btn-submit-create-shift");

  if (!categoryName) {
    alert("Please provide a bar/area category name.");
    return;
  }

  if (!startVal || !endVal) {
    alert("Please specify start and end dates and times.");
    return;
  }

  const startDate = new Date(startVal);
  const endDate = new Date(endVal);

  if (endDate <= startDate) {
    alert("Shift end time must be after the start time.");
    return;
  }

  if (isNaN(capacity) || capacity < 1) {
    alert("Capacity must be at least 1 volunteer.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerText = "Creating Shift...";

  try {
    const createShiftFn = functions.httpsCallable("createShift");
    await createShiftFn({
      dayIndex: dayIndex,
      categoryName: categoryName,
      capacity: capacity,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
      managerUserId: managerUserId,
    });

    closeCreateShiftModal();
    alert("Shift created successfully!");

    if (selectedDay !== dayIndex) {
      selectedDay = dayIndex;
      renderDayTabs();
      subscribeToShifts();
    }
  } catch (err) {
    alert("Failed to create shift: " + err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerText = "Create Shift";
  }
}

// ============================================================================
// REQUIREMENT B: View Roster & Cancel Individual Users' Shifts (Admin)
// ============================================================================
async function openShiftRosterModal(shiftId) {
  activeRosterShiftId = shiftId;
  const modal = document.getElementById("shift-roster-modal");
  const titleEl = document.getElementById("roster-modal-shift-title");
  const listEl = document.getElementById("roster-modal-list");
  const countEl = document.getElementById("roster-modal-count");

  modal.classList.remove("hidden");
  listEl.innerHTML = `<p class="text-xs text-slate-500 italic py-6 text-center">Loading registrations...</p>`;

  let shiftInfo = "";
  try {
    const shiftDoc = await db.collection("shifts").doc(shiftId).get();
    if (shiftDoc.exists) {
      const shift = shiftDoc.data();
      const sTime = formatTime(shift.startTime);
      const eTime = formatTime(shift.endTime);
      shiftInfo = `Day ${shift.dayIndex} &bull; ${escapeHtml(shift.categoryName)} (${sTime} &ndash; ${eTime})`;
    }
  } catch (e) {
    console.error("Error loading shift for roster:", e);
  }
  titleEl.innerHTML = shiftInfo || "Shift Registrations";

  try {
    const regSnapshot = await db.collection("registrations")
      .where("shiftId", "==", shiftId)
      .where("status", "==", "confirmed")
      .get();

    if (regSnapshot.empty) {
      listEl.innerHTML = `<p class="text-xs text-slate-500 italic py-6 text-center">No volunteers are currently registered for this shift.</p>`;
      countEl.innerText = "0 Volunteers Registered";
      return;
    }

    countEl.innerText = `${regSnapshot.size} Volunteer${regSnapshot.size === 1 ? '' : 's'} Registered`;

    const userPromises = regSnapshot.docs.map(async doc => {
      const reg = doc.data();
      let user = allUsersMap.get(reg.userId);
      if (!user) {
        try {
          const userDoc = await db.collection("users").doc(reg.userId).get();
          if (userDoc.exists) {
            user = { id: userDoc.id, ...userDoc.data() };
          }
        } catch (err) {
          console.warn("Could not fetch user profile:", reg.userId);
        }
      }
      return {
        regId: doc.id,
        userId: reg.userId,
        registeredAt: reg.registeredAt,
        fullName: user?.fullName || "Volunteer",
        email: user?.email || "Unknown email",
        role: user?.role || "volunteer"
      };
    });

    const volunteers = await Promise.all(userPromises);

    listEl.innerHTML = "";
    volunteers.forEach(v => {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between p-3 rounded-lg border border-amber-200 bg-amber-50/50 hover:bg-amber-50 transition gap-3";

      const registeredDateStr = v.registeredAt ? formatDate(v.registeredAt) + " at " + formatTime(v.registeredAt) : "Recently";

      let cancelBtnHtml = "";
      if (currentUserRole === "admin") {
        cancelBtnHtml = `
          <button onclick="adminCancelUserShift('${shiftId}', '${v.userId}', '${escapeJs(v.fullName)}')" class="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 transition shadow-xs flex-shrink-0">
            Cancel Shift
          </button>
        `;
      }

      row.innerHTML = `
        <div class="flex items-center space-x-2.5 overflow-hidden">
          <div class="w-8 h-8 rounded-full bg-amber-200 text-amber-900 font-bold flex items-center justify-center text-xs flex-shrink-0">
            ${escapeHtml((v.fullName || "V")[0].toUpperCase())}
          </div>
          <div class="truncate">
            <p class="font-bold text-slate-800 text-xs truncate">${escapeHtml(v.fullName)}</p>
            <p class="text-[11px] text-slate-500 truncate">${escapeHtml(v.email)}</p>
            <p class="text-[10px] text-slate-400">Registered: ${registeredDateStr}</p>
          </div>
        </div>
        ${cancelBtnHtml}
      `;
      listEl.appendChild(row);
    });
  } catch (err) {
    console.error("Error loading roster:", err);
    listEl.innerHTML = `<p class="text-xs text-rose-500 py-4 text-center">Failed to load roster: ${err.message}</p>`;
  }
}

function closeShiftRosterModal() {
  activeRosterShiftId = null;
  document.getElementById("shift-roster-modal").classList.add("hidden");
}

async function adminCancelUserShift(shiftId, targetUserId, userName) {
  if (!confirm(`Are you sure you want to cancel the shift registration for ${userName}?\n\nThis will remove the volunteer and decrement the shift capacity.`)) {
    return;
  }

  try {
    const cancelFn = functions.httpsCallable("cancelShift");
    await cancelFn({ shiftId: shiftId, targetUserId: targetUserId });
    alert(`Successfully cancelled shift registration for ${userName}.`);
    openShiftRosterModal(shiftId);
  } catch (err) {
    alert("Cancellation failed: " + err.message);
  }
}

// ============================================================================
// REQUIREMENT C: Change Standard Volunteer Users to Manager or Admin (Admin)
// ============================================================================
function handleAdminUserSearch(query) {
  adminUserFilterText = (query || "").trim().toLowerCase();
  renderAdminUsers();
}

function handleAdminRoleFilter(role) {
  adminRoleFilter = role;
  renderAdminUsers();
}

function renderAdminUsers() {
  const tableBody = document.getElementById("admin-users-table-body");
  if (!tableBody) return;

  const users = Array.from(allUsersMap.values());

  // Update Counters
  let countVolunteers = 0;
  let countManagers = 0;
  let countAdmins = 0;

  users.forEach(u => {
    const r = u.role || "volunteer";
    if (r === "admin") countAdmins++;
    else if (r === "manager") countManagers++;
    else countVolunteers++;
  });

  const statTotal = document.getElementById("stat-total-users");
  const statVol = document.getElementById("stat-volunteers");
  const statMgr = document.getElementById("stat-managers");
  const statAdm = document.getElementById("stat-admins");

  if (statTotal) statTotal.innerText = users.length;
  if (statVol) statVol.innerText = countVolunteers;
  if (statMgr) statMgr.innerText = countManagers;
  if (statAdm) statAdm.innerText = countAdmins;

  // Filter users
  const filteredUsers = users.filter(u => {
    const roleMatch = adminRoleFilter === "ALL" || (u.role || "volunteer") === adminRoleFilter;
    const nameStr = (u.fullName || "").toLowerCase();
    const emailStr = (u.email || "").toLowerCase();
    const searchMatch = !adminUserFilterText || nameStr.includes(adminUserFilterText) || emailStr.includes(adminUserFilterText);
    return roleMatch && searchMatch;
  });

  if (filteredUsers.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="4" class="p-6 text-center text-slate-500 italic">
          No crew members found matching your search.
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = "";
  filteredUsers.forEach(u => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-amber-50/50 transition";

    const userRole = u.role || "volunteer";
    const isSelf = currentUser && u.id === currentUser.uid;

    let roleBadgeClass = "bg-amber-100 text-amber-900 border border-amber-300";
    let roleLabel = "🤝 Volunteer";
    if (userRole === "admin") {
      roleBadgeClass = "bg-purple-100 text-purple-900 border border-purple-300";
      roleLabel = "👑 Administrator";
    } else if (userRole === "manager") {
      roleBadgeClass = "bg-blue-100 text-blue-900 border border-blue-300";
      roleLabel = "👔 Shift Manager";
    }

    tr.innerHTML = `
      <td class="p-3">
        <div class="flex items-center space-x-2.5">
          <div class="w-7 h-7 rounded-full bg-amber-200 text-amber-900 font-bold flex items-center justify-center text-xs flex-shrink-0">
            ${escapeHtml((u.fullName || u.email || "U")[0].toUpperCase())}
          </div>
          <div>
            <p class="font-bold text-slate-800 text-xs">${escapeHtml(u.fullName || "Volunteer")} ${isSelf ? '<span class="text-[10px] text-amber-800 font-semibold bg-amber-100 px-1 py-0.2 rounded">(You)</span>' : ''}</p>
          </div>
        </div>
      </td>
      <td class="p-3 text-slate-600 font-mono text-[11px]">${escapeHtml(u.email || "No email")}</td>
      <td class="p-3">
        <span class="text-[11px] font-bold px-2 py-0.5 rounded-full ${roleBadgeClass}">
          ${roleLabel}
        </span>
      </td>
      <td class="p-3 text-right">
        ${isSelf ? `
          <span class="text-[11px] text-slate-400 italic">Current User</span>
        ` : `
          <select onchange="changeUserRole('${u.id}', this.value, '${escapeJs(u.fullName || u.email)}', this)" class="text-xs p-1.5 rounded-lg border border-slate-300 bg-white font-medium focus:ring-2 focus:ring-amber-500 focus:outline-none">
            <option value="volunteer" ${userRole === 'volunteer' ? 'selected' : ''}>Volunteer</option>
            <option value="manager" ${userRole === 'manager' ? 'selected' : ''}>Shift Manager</option>
            <option value="admin" ${userRole === 'admin' ? 'selected' : ''}>Administrator</option>
          </select>
        `}
      </td>
    `;
    tableBody.appendChild(tr);
  });
}

async function changeUserRole(targetUserId, newRole, userName, selectEl) {
  const confirmMsg = `Are you sure you want to change the role of "${userName}" to "${newRole.toUpperCase()}"?`;
  if (!confirm(confirmMsg)) {
    renderAdminUsers();
    return;
  }

  if (selectEl) selectEl.disabled = true;

  try {
    const updateRoleFn = functions.httpsCallable("updateUserRole");
    await updateRoleFn({ targetUserId: targetUserId, newRole: newRole });
    alert(`Successfully updated role of ${userName} to ${newRole}.`);
  } catch (err) {
    alert("Role update failed: " + err.message);
    renderAdminUsers();
  }
}

// ============================================================================
// REQUIREMENT D: Manager Users Assign Themselves (Only 1 Manager Per Shift)
// ============================================================================
async function managerClaimShift(shiftId) {
  if (!confirm("Assign yourself as the manager for this shift?")) {
    return;
  }

  try {
    const assignFn = functions.httpsCallable("assignShiftManager");
    await assignFn({ shiftId: shiftId, managerUserId: currentUser.uid });
    alert("You have been assigned as the manager for this shift!");
  } catch (err) {
    alert("Manager assignment failed: " + err.message);
  }
}

async function managerUnassignShift(shiftId) {
  if (!confirm("Are you sure you want to step down as manager for this shift?")) {
    return;
  }

  try {
    const assignFn = functions.httpsCallable("assignShiftManager");
    await assignFn({ shiftId: shiftId, managerUserId: null });
    alert("You have stepped down as manager for this shift.");
  } catch (err) {
    alert("Failed to unassign: " + err.message);
  }
}

// ============================================================================
// REQUIREMENT E: Admins Assign Manager Users to Shifts
// ============================================================================
async function openAssignManagerModal(shiftId) {
  activeAssignModalShiftId = shiftId;
  const modal = document.getElementById("assign-manager-modal");
  const shiftInfoEl = document.getElementById("assign-modal-shift-info");
  const timeInfoEl = document.getElementById("assign-modal-time-info");
  const curMgrEl = document.getElementById("assign-modal-current-manager");
  const selectEl = document.getElementById("assign-manager-select");

  populateManagerDropdowns();

  try {
    const shiftDoc = await db.collection("shifts").doc(shiftId).get();
    if (shiftDoc.exists) {
      const shift = shiftDoc.data();
      shiftInfoEl.innerText = `Day ${shift.dayIndex} • ${shift.categoryName}`;
      timeInfoEl.innerText = `${formatTime(shift.startTime)} – ${formatTime(shift.endTime)} (${formatDate(shift.startTime)})`;
      curMgrEl.innerText = `Current Manager: ${shift.managerName || "None (Assigned On-Site)"}`;
      selectEl.value = shift.managerId || "";
    }
  } catch (e) {
    console.error("Error reading shift for manager assignment:", e);
  }

  modal.classList.remove("hidden");
}

function closeAssignManagerModal() {
  activeAssignModalShiftId = null;
  document.getElementById("assign-manager-modal").classList.add("hidden");
}

async function handleSaveManagerAssignment() {
  if (!activeAssignModalShiftId) return;

  const selectEl = document.getElementById("assign-manager-select");
  const selectedUserId = selectEl.value || null;
  const saveBtn = document.getElementById("btn-save-manager-assign");

  saveBtn.disabled = true;
  saveBtn.innerText = "Saving...";

  try {
    const assignFn = functions.httpsCallable("assignShiftManager");
    await assignFn({
      shiftId: activeAssignModalShiftId,
      managerUserId: selectedUserId,
    });
    closeAssignManagerModal();
    alert("Shift manager updated successfully!");
  } catch (err) {
    alert("Failed to update manager: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerText = "Save Manager";
  }
}

// ============================================================================
// Date / Time Utilities
// ============================================================================
function formatTime(ts) {
  if (!ts) return "TBD";
  const date = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts.seconds ? ts.seconds * 1000 : ts);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(ts) {
  if (!ts) return "";
  const date = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts.seconds ? ts.seconds * 1000 : ts);
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function getShiftStartTimeMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts.seconds) return ts.seconds * 1000;
  return new Date(ts).getTime();
}

function isShiftLocked(startTime) {
  const startTimeMs = getShiftStartTimeMs(startTime);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return (startTimeMs - Date.now()) < sevenDaysMs;
}

function formatForDateTimeLocal(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

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
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}
