import { createClient } from "@supabase/supabase-js";
import "./styles.css";

const USER_KEY = "coloc-ecole-user-id";
const LOG_PREFIX = "[Coloc Supabase]";

const form = document.querySelector("#group-form");
const signupForm = document.querySelector("#signup-form");
const groupsContainer = document.querySelector("#groups");
const template = document.querySelector("#group-card-template");
const groupCount = document.querySelector("#group-count");
const spotCount = document.querySelector("#spot-count");
const filters = document.querySelectorAll(".filter");
const guestView = document.querySelector("#guest-view");
const userView = document.querySelector("#user-view");
const userAvatar = document.querySelector("#user-avatar");
const userName = document.querySelector("#user-name");
const userMeta = document.querySelector("#user-meta");
const logoutButton = document.querySelector("#logout-button");
const createLock = document.querySelector("#create-lock");
const cancelEditButton = document.querySelector("#cancel-edit-button");

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const client = createClient(supabaseUrl, supabaseAnonKey);

let activeFilter = "Tous";
let groups = [];
let currentUser = null;
let isSubmitting = false;
let editingGroupId = null;

function logInfo(step, payload = {}) {
  console.log(`${LOG_PREFIX} ${step}`, payload);
}

function logError(step, error, payload = {}) {
  console.error(`${LOG_PREFIX} ${step}`, {
    message: error?.message,
    code: error?.code,
    details: error?.details,
    hint: error?.hint,
    payload
  });
}

function assertSupabaseConfig() {
  const hasUrl = Boolean(supabaseUrl);
  const hasKey = Boolean(supabaseAnonKey);

  if (!hasUrl || !hasKey) {
    throw new Error("Variables Vite manquantes : VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY.");
  }
}

function toAppGroup(group) {
  const creatorName = group.creator?.first_name || "quelqu'un";
  const people = (group.group_people || []).slice().sort((a, b) => Number(b.is_creator) - Number(a.is_creator));

  return {
    id: group.id,
    creatorId: group.creator_id,
    name: `Coloc de ${creatorName}`,
    schoolGroup: group.school_group,
    capacity: group.capacity,
    availableSpots: group.available_spots ?? group.capacity,
    people,
    genderRule: group.gender_rule,
    city: group.city,
    contact: group.contact,
    notes: group.notes
  };
}

function parseExistingPeople(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [firstName, schoolGroup = "Autre"] = line.split(/[-,;]/).map((part) => part.trim());
      const normalizedGroup = ["L", "M", "N", "Autre"].includes(schoolGroup) ? schoolGroup : "Autre";

      return {
        first_name: firstName,
        school_group: normalizedGroup
      };
    })
    .filter((person) => person.first_name);
}

function formatExistingPeople(people) {
  return people
    .filter((person) => !person.is_creator)
    .map((person) => `${person.first_name} - ${person.school_group}`)
    .join("\n");
}

function getInitials(name) {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function canJoinGroup(group, gender) {
  if (group.genderRule === "Mixte") {
    return true;
  }

  if (group.genderRule === "Hommes seulement") {
    return gender === "Homme";
  }

  return gender === "Femme";
}

function getGroupFormPayload(data) {
  return {
    p_school_group: data.get("schoolGroup"),
    p_capacity: Number(data.get("capacity")),
    p_available_spots: Number(data.get("availableSpots")),
    p_gender_rule: data.get("genderRule"),
    p_city: data.get("city").trim(),
    p_contact: data.get("contact").trim(),
    p_notes: data.get("notes").trim() || null,
    p_existing_people: parseExistingPeople(data.get("existingMembers"))
  };
}

function validateGroupPayload(payload) {
  if (payload.p_available_spots < 0 || payload.p_available_spots > payload.p_capacity) {
    alert("Les places disponibles doivent être entre 0 et le nombre total de places.");
    return false;
  }

  const occupiedSpots = 1 + payload.p_existing_people.length;

  if (occupiedSpots + payload.p_available_spots > payload.p_capacity) {
    alert("Les personnes déjà présentes + les places disponibles dépassent le nombre total de places.");
    return false;
  }

  if (!canJoinGroup({ genderRule: payload.p_gender_rule }, currentUser.gender)) {
    alert("Le type de coloc choisi ne correspond pas à votre profil.");
    return false;
  }

  return true;
}

function resetGroupForm() {
  editingGroupId = null;
  form.reset();
  form.capacity.value = 4;
  form.availableSpots.value = 3;
  form.querySelector('button[type="submit"]').textContent = "Créer le groupe";
  form.querySelector('button[type="submit"]').dataset.label = "Créer le groupe";
  cancelEditButton.classList.add("hidden");
}

function getFilteredGroups() {
  if (activeFilter === "Tous") {
    return groups;
  }

  return groups.filter((group) => group.schoolGroup === activeFilter);
}

function setMessage(message) {
  groupsContainer.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = message;
  groupsContainer.append(empty);
}

function setSubmitState(button, loadingText, isLoading) {
  if (!button) {
    return;
  }

  if (!button.dataset.label) {
    button.dataset.label = button.textContent;
  }

  button.disabled = isLoading;
  button.textContent = isLoading ? loadingText : button.dataset.label;
}

function showSupabaseError(action, error) {
  logError(action, error);
  alert(`${action} : ${error.message || "erreur Supabase inconnue"}`);
}

function updateAccountView() {
  const isConnected = Boolean(currentUser);

  guestView.classList.toggle("hidden", isConnected);
  userView.classList.toggle("hidden", !isConnected);
  form.classList.toggle("locked", !isConnected);
  createLock.classList.toggle("hidden", isConnected);

  [...form.elements].forEach((element) => {
    element.disabled = !isConnected || isSubmitting;
  });

  if (!currentUser) {
    return;
  }

  userName.textContent = currentUser.first_name;
  userMeta.textContent = `Groupe ${currentUser.school_group} · ${currentUser.gender}`;
  userAvatar.textContent = currentUser.avatar ? "" : getInitials(currentUser.first_name);
  userAvatar.style.backgroundImage = currentUser.avatar ? `url("${currentUser.avatar}")` : "";
}

function render() {
  const visibleGroups = getFilteredGroups();
  groupsContainer.replaceChildren();
  updateAccountView();

  if (groupCount) {
    groupCount.textContent = groups.length;
  }

  if (spotCount) {
    spotCount.textContent = groups.reduce((total, group) => total + Math.max(group.availableSpots, 0), 0);
  }

  if (visibleGroups.length === 0) {
    setMessage("Aucun groupe pour ce filtre. Créez le premier.");
    return;
  }

  visibleGroups
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "fr"))
    .forEach((group) => {
      const card = template.content.firstElementChild.cloneNode(true);
      const remaining = Math.max(group.availableSpots, 0);
      const contactButton = card.querySelector(".contact-button");
      const editButton = card.querySelector(".edit-button");
      const isCreator = Boolean(currentUser) && group.creatorId === currentUser.id;
      const memberList = card.querySelector(".member-list");

      card.querySelector(".badge").textContent = `Groupe ${group.schoolGroup}`;
      card.querySelector("h3").textContent = group.name;
      card.querySelector(".city").textContent = group.city;
      card.querySelector(".spots").textContent = `${remaining}/${group.capacity}`;
      card.querySelector(".gender-rule").textContent = group.genderRule;
      card.querySelector(".notes").textContent = group.notes || "Pas de détail ajouté pour le moment.";
      card.querySelector(".contact").textContent = `Contact : ${group.contact}`;

      contactButton.disabled = isSubmitting;
      contactButton.addEventListener("click", () => contactGroup(group));

      editButton.classList.toggle("hidden", !isCreator);
      editButton.addEventListener("click", () => editGroup(group));

      group.people.forEach((person) => {
        const item = document.createElement("div");
        const avatar = document.createElement("span");
        const label = document.createElement("span");

        item.className = "person-pill";
        avatar.className = "mini-avatar";
        avatar.textContent = person.avatar ? "" : getInitials(person.first_name);
        avatar.style.backgroundImage = person.avatar ? `url("${person.avatar}")` : "";
        label.textContent = `${person.first_name} · Groupe ${person.school_group}${person.is_creator ? " · créateur" : ""}`;

        item.append(avatar, label);
        memberList.append(item);
      });

      groupsContainer.append(card);
    });
}

async function loadCurrentUser() {
  const userId = localStorage.getItem(USER_KEY);
  logInfo("loadCurrentUser:start", { userId });

  if (!userId) {
    currentUser = null;
    logInfo("loadCurrentUser:no-local-user");
    return;
  }

  const { data, error } = await client
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    logError("loadCurrentUser:error", error, { userId });
    localStorage.removeItem(USER_KEY);
    currentUser = null;
    return;
  }

  if (!data) {
    logInfo("loadCurrentUser:not-found", { userId });
    localStorage.removeItem(USER_KEY);
    currentUser = null;
    return;
  }

  currentUser = data;
  logInfo("loadCurrentUser:success", { userId: data.id, firstName: data.first_name });
}

async function loadGroups() {
  logInfo("loadGroups:start");

  const { data, error } = await client
    .from("groups")
    .select(`
      *,
      creator:profiles!groups_creator_id_fkey (
        first_name
      ),
      group_people (
        first_name,
        school_group,
        avatar,
        is_creator
      ),
      group_members (
        profile_id,
        profiles (
          first_name,
          avatar,
          gender
        )
      )
    `)
    .order("created_at", { ascending: false });

  if (error) {
    logError("loadGroups:error", error);
    setMessage(`Impossible de charger les groupes : ${error.message}`);
    return;
  }

  groups = data.map((group) => {
    const appGroup = toAppGroup(group);
    appGroup.memberIds = (group.group_members || []).map((member) => member.profile_id);
    return appGroup;
  });
  logInfo("loadGroups:success", { count: groups.length });
}

async function refresh() {
  try {
    assertSupabaseConfig();
    setMessage("Chargement des groupes...");
    await loadCurrentUser();
    await loadGroups();
    render();
  } catch (error) {
    logError("refresh:error", error);
    setMessage(error.message);
  }
}

async function contactGroup(group) {
  logInfo("contactGroup", { groupId: group.id, contact: group.contact });

  try {
    await navigator.clipboard.writeText(group.contact);
    alert(`Contact copié : ${group.contact}`);
  } catch {
    alert(`Contact : ${group.contact}`);
  }
}

function editGroup(group) {
  editingGroupId = group.id;
  form.schoolGroup.value = group.schoolGroup;
  form.genderRule.value = group.genderRule;
  form.capacity.value = group.capacity;
  form.availableSpots.value = group.availableSpots;
  form.existingMembers.value = formatExistingPeople(group.people);
  form.city.value = group.city;
  form.contact.value = group.contact;
  form.notes.value = group.notes || "";
  form.querySelector('button[type="submit"]').textContent = "Enregistrer";
  form.querySelector('button[type="submit"]').dataset.label = "Enregistrer";
  cancelEditButton.classList.remove("hidden");
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentUser) {
    alert("Inscrivez-vous pour créer une coloc.");
    return;
  }

  if (isSubmitting) {
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  const payload = getGroupFormPayload(data);

  if (!validateGroupPayload(payload)) {
    return;
  }

  isSubmitting = true;
  setSubmitState(submitButton, editingGroupId ? "Enregistrement..." : "Création...", true);
  updateAccountView();
  logInfo(editingGroupId ? "updateGroup:start" : "createGroup:start", { editingGroupId, payload });

  const request = editingGroupId
    ? client.rpc("update_coloc_group", {
      p_group_id: editingGroupId,
      p_editor_id: currentUser.id,
      ...payload
    })
    : client.rpc("create_coloc_group", {
      p_creator_id: currentUser.id,
      ...payload
    });

  const { data: groupId, error } = await request;

  isSubmitting = false;
  setSubmitState(submitButton, editingGroupId ? "Enregistrement..." : "Création...", false);

  if (error) {
    showSupabaseError(editingGroupId ? "Impossible de modifier le groupe" : "Impossible de créer le groupe", error);
    updateAccountView();
    return;
  }

  logInfo(editingGroupId ? "updateGroup:success" : "createGroup:success", { groupId, editingGroupId });
  resetGroupForm();
  activeFilter = "Tous";
  filters.forEach((button) => button.classList.toggle("active", button.dataset.filter === activeFilter));
  await refresh();
});

cancelEditButton.addEventListener("click", () => {
  resetGroupForm();
});

signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (isSubmitting) {
    return;
  }

  const submitButton = signupForm.querySelector('button[type="submit"]');
  const data = new FormData(signupForm);
  const avatar = data.get("avatar");

  const createUser = async (avatarData = "") => {
    const payload = {
      first_name: data.get("firstName").trim(),
      school_group: data.get("schoolGroup"),
      gender: data.get("gender"),
      avatar: avatarData || null
    };

    isSubmitting = true;
    setSubmitState(submitButton, "Inscription...", true);
    logInfo("createProfile:start", { ...payload, avatar: avatarData ? "[image]" : null });

    const { data: profile, error } = await client
      .from("profiles")
      .insert(payload)
      .select("*")
      .single();

    isSubmitting = false;
    setSubmitState(submitButton, "Inscription...", false);

    if (error) {
      showSupabaseError("Impossible de créer le profil", error);
      return;
    }

    currentUser = profile;
    localStorage.setItem(USER_KEY, profile.id);
    signupForm.reset();
    logInfo("createProfile:success", { profileId: profile.id });
    await refresh();
  };

  if (avatar && avatar.size > 0) {
    const reader = new FileReader();
    reader.addEventListener("load", () => createUser(reader.result));
    reader.addEventListener("error", () => alert("Impossible de lire la photo de profil."));
    reader.readAsDataURL(avatar);
    return;
  }

  await createUser();
});

logoutButton.addEventListener("click", () => {
  logInfo("logout", { userId: currentUser?.id });
  currentUser = null;
  localStorage.removeItem(USER_KEY);
  render();
});

filters.forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    filters.forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});

refresh();
