import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

// ============================================================================
// SUPABASE CONFIG — replace with your project values
// Get these from: Supabase Dashboard → Project Settings → API
// ============================================================================
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function MilkTracker() {
  // Auth + household state
  const [session, setSession] = useState(null);
  const [household, setHousehold] = useState(null);
  const [members, setMembers] = useState([]);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [authMode, setAuthMode] = useState('signin'); // signin, signup
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // App state
  const [view, setView] = useState('today');
  const [adjustments, setAdjustments] = useState({});
  const [rates, setRates] = useState([]);
  const [defaults, setDefaults] = useState({ blue: 1.5, orange: 1.0 });
  const [showRateForm, setShowRateForm] = useState(false);
  const [showDefaultsForm, setShowDefaultsForm] = useState(false);
  const [showHouseholdMenu, setShowHouseholdMenu] = useState(false);
  const [newRate, setNewRate] = useState({ startDate: '', bluePerHalf: '', orangePerHalf: '' });
  const [tempDefaults, setTempDefaults] = useState({ blue: '1.5', orange: '1.0' });
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [householdName, setHouseholdName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [syncing, setSyncing] = useState(false);

  // ==========================================================================
  // AUTH
  // ==========================================================================
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoadingAuth(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = async () => {
    setAuthError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setAuthError(error.message);
  };

  const signUp = async () => {
    setAuthError('');
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) setAuthError(error.message);
    else setAuthError('Check your email to confirm your account, then sign in.');
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setHousehold(null);
    setAdjustments({});
    setRates([]);
  };

  // ==========================================================================
  // LOAD HOUSEHOLD ON SIGN IN
  // ==========================================================================
  const loadHousehold = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase
      .from('household_members')
      .select('household_id, households(*)')
      .eq('user_id', session.user.id)
      .limit(1)
      .single();

    if (data) {
      setHousehold(data.households);
      setDefaults({ blue: data.households.default_blue, orange: data.households.default_orange });
    }
  }, [session]);

  useEffect(() => { loadHousehold(); }, [loadHousehold]);

  // ==========================================================================
  // LOAD DATA FOR HOUSEHOLD
  // ==========================================================================
  const loadData = useCallback(async () => {
    if (!household) return;
    setSyncing(true);

    const [ratesRes, adjRes, membersRes] = await Promise.all([
      supabase.from('rates').select('*').eq('household_id', household.id),
      supabase.from('adjustments').select('*').eq('household_id', household.id),
      supabase.from('household_members').select('user_id, role').eq('household_id', household.id),
    ]);

    if (ratesRes.data) {
      setRates(ratesRes.data.map(r => ({
        startDate: r.start_date,
        bluePerHalf: parseFloat(r.blue_per_half),
        orangePerHalf: parseFloat(r.orange_per_half),
      })));
    }

    if (adjRes.data) {
      const adjMap = {};
      adjRes.data.forEach(a => {
        adjMap[a.date] = { blue: parseFloat(a.blue), orange: parseFloat(a.orange) };
      });
      setAdjustments(adjMap);
    }

    if (membersRes.data) setMembers(membersRes.data);

    setSyncing(false);
  }, [household]);

  useEffect(() => { loadData(); }, [loadData]);

  // ==========================================================================
  // REALTIME SUBSCRIPTIONS
  // ==========================================================================
  useEffect(() => {
    if (!household) return;

    const channel = supabase
      .channel(`household:${household.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'adjustments',
        filter: `household_id=eq.${household.id}`
      }, (payload) => {
        if (payload.eventType === 'DELETE') {
          setAdjustments(prev => {
            const copy = { ...prev };
            delete copy[payload.old.date];
            return copy;
          });
        } else {
          const a = payload.new;
          setAdjustments(prev => ({
            ...prev,
            [a.date]: { blue: parseFloat(a.blue), orange: parseFloat(a.orange) }
          }));
        }
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'rates',
        filter: `household_id=eq.${household.id}`
      }, () => loadData())
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'households',
        filter: `id=eq.${household.id}`
      }, (payload) => {
        setHousehold(payload.new);
        setDefaults({ blue: payload.new.default_blue, orange: payload.new.default_orange });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [household, loadData]);

  // ==========================================================================
  // HOUSEHOLD CREATION / JOINING
  // ==========================================================================
  const createHousehold = async () => {
    if (!householdName.trim()) return;
    const { data: hh, error } = await supabase
      .from('households')
      .insert({ name: householdName.trim() })
      .select()
      .single();
    if (error) { alert(error.message); return; }

    await supabase.from('household_members').insert({
      household_id: hh.id,
      user_id: session.user.id,
      role: 'owner'
    });
    setHousehold(hh);
  };

  const joinHousehold = async () => {
    if (!joinCode.trim()) return;
    const { error } = await supabase.from('household_members').insert({
      household_id: joinCode.trim(),
      user_id: session.user.id,
      role: 'member'
    });
    if (error) { alert('Could not join. Check the code.'); return; }
    await loadHousehold();
  };

  // ==========================================================================
  // CALCULATIONS (same as before)
  // ==========================================================================
  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const formatDateShort = (dateStr) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  const getRateForDate = (dateStr) => {
    if (rates.length === 0) return null;
    const sorted = [...rates].sort((a, b) => b.startDate.localeCompare(a.startDate));
    for (const r of sorted) if (dateStr >= r.startDate) return r;
    return null;
  };

  const todayAdj = adjustments[selectedDate] || { blue: 0, orange: 0 };

  // ==========================================================================
  // WRITES (now hit Supabase)
  // ==========================================================================
  const upsertAdjustment = async (date, blue, orange) => {
    if (!household) return;
    if (blue === 0 && orange === 0) {
      await supabase.from('adjustments')
        .delete()
        .eq('household_id', household.id)
        .eq('date', date);
    } else {
      await supabase.from('adjustments').upsert({
        household_id: household.id,
        date, blue, orange,
        updated_by: session.user.id,
        updated_at: new Date().toISOString(),
      });
    }
  };

  const updateAdj = async (type, delta) => {
    const current = adjustments[selectedDate] || { blue: 0, orange: 0 };
    const min = -defaults[type];
    const max = 10;
    const newVal = Math.max(min, Math.min(max, Math.round((current[type] + delta) * 2) / 2));
    const updated = { ...current, [type]: newVal };
    // Optimistic local update
    setAdjustments(prev => {
      if (updated.blue === 0 && updated.orange === 0) {
        const copy = { ...prev };
        delete copy[selectedDate];
        return copy;
      }
      return { ...prev, [selectedDate]: updated };
    });
    await upsertAdjustment(selectedDate, updated.blue, updated.orange);
  };

  const markFullSkip = async () => {
    const updated = { blue: -defaults.blue, orange: -defaults.orange };
    setAdjustments(prev => ({ ...prev, [selectedDate]: updated }));
    await upsertAdjustment(selectedDate, updated.blue, updated.orange);
  };

  const clearAdj = async () => {
    setAdjustments(prev => {
      const copy = { ...prev };
      delete copy[selectedDate];
      return copy;
    });
    await upsertAdjustment(selectedDate, 0, 0);
  };

  const addRate = async () => {
    if (!newRate.startDate || !newRate.bluePerHalf || !newRate.orangePerHalf) return;
    const { error } = await supabase.from('rates').insert({
      household_id: household.id,
      start_date: newRate.startDate,
      blue_per_half: parseFloat(newRate.bluePerHalf),
      orange_per_half: parseFloat(newRate.orangePerHalf),
    });
    if (error) { alert(error.message); return; }
    setNewRate({ startDate: '', bluePerHalf: '', orangePerHalf: '' });
    setShowRateForm(false);
  };

  const deleteRate = async (startDate) => {
    if (!confirm('Remove this rate?')) return;
    await supabase.from('rates')
      .delete()
      .eq('household_id', household.id)
      .eq('start_date', startDate);
  };

  const saveDefaults = async () => {
    const b = parseFloat(tempDefaults.blue);
    const o = parseFloat(tempDefaults.orange);
    if (isNaN(b) || isNaN(o) || b < 0 || o < 0) return;
    await supabase.from('households')
      .update({ default_blue: b, default_orange: o })
      .eq('id', household.id);
    setShowDefaultsForm(false);
  };

  // ==========================================================================
  // MONTH CALCULATIONS
  // ==========================================================================
  const daysInMonth = (year, month) => new Date(year, month, 0).getDate();

  const calcMonth = (monthPrefix) => {
    const [yr, mo] = monthPrefix.split('-').map(Number);
    const totalDays = daysInMonth(yr, mo);
    let blueTaken = 0, orangeTaken = 0;
    let blueSkipped = 0, orangeSkipped = 0;
    let blueExtra = 0, orangeExtra = 0;
    let takenCost = 0, skippedCost = 0, extraCost = 0;

    for (let d = 1; d <= totalDays; d++) {
      const dateStr = `${monthPrefix}-${String(d).padStart(2, '0')}`;
      const rate = getRateForDate(dateStr);
      const adj = adjustments[dateStr] || { blue: 0, orange: 0 };
      const blueActual = Math.max(0, defaults.blue + adj.blue);
      const orangeActual = Math.max(0, defaults.orange + adj.orange);
      blueTaken += blueActual;
      orangeTaken += orangeActual;
      if (adj.blue < 0) blueSkipped += -adj.blue;
      else if (adj.blue > 0) blueExtra += adj.blue;
      if (adj.orange < 0) orangeSkipped += -adj.orange;
      else if (adj.orange > 0) orangeExtra += adj.orange;
      if (rate) {
        takenCost += (blueActual * 2 * rate.bluePerHalf) + (orangeActual * 2 * rate.orangePerHalf);
        if (adj.blue < 0) skippedCost += (-adj.blue) * 2 * rate.bluePerHalf;
        if (adj.orange < 0) skippedCost += (-adj.orange) * 2 * rate.orangePerHalf;
        if (adj.blue > 0) extraCost += adj.blue * 2 * rate.bluePerHalf;
        if (adj.orange > 0) extraCost += adj.orange * 2 * rate.orangePerHalf;
      }
    }
    return { blueTaken, orangeTaken, blueSkipped, orangeSkipped, blueExtra, orangeExtra, takenCost, skippedCost, extraCost };
  };

  const currentMonthPrefix = selectedDate.substring(0, 7);
  const currentMonth = useMemo(() => calcMonth(currentMonthPrefix), [adjustments, rates, defaults, currentMonthPrefix]);
  const lastMonthPrefix = useMemo(() => {
    const [yr, mo] = currentMonthPrefix.split('-').map(Number);
    const prevMo = mo === 1 ? 12 : mo - 1;
    const prevYr = mo === 1 ? yr - 1 : yr;
    return `${prevYr}-${String(prevMo).padStart(2, '0')}`;
  }, [currentMonthPrefix]);
  const lastMonth = useMemo(() => calcMonth(lastMonthPrefix), [adjustments, rates, defaults, lastMonthPrefix]);
  const lastMonthNetCredit = lastMonth.skippedCost - lastMonth.extraCost;
  const billPayable = currentMonth.takenCost - lastMonthNetCredit;
  const currentRate = getRateForDate(selectedDate);
  const adjDays = useMemo(() => Object.entries(adjustments)
    .filter(([_, a]) => a.blue !== 0 || a.orange !== 0)
    .sort((a, b) => b[0].localeCompare(a[0])), [adjustments]);

  const buildStatusText = () => {
    if (todayAdj.blue === 0 && todayAdj.orange === 0) {
      return `✓ Full delivery: ${defaults.blue}L Blue + ${defaults.orange}L Orange`;
    }
    const blueActual = defaults.blue + todayAdj.blue;
    const orangeActual = defaults.orange + todayAdj.orange;
    return `Today: ${blueActual.toFixed(1)}L Blue + ${orangeActual.toFixed(1)}L Orange`;
  };

  // ==========================================================================
  // STYLES (same as before, condensed)
  // ==========================================================================
  const styles = {
    container: { fontFamily: '"Nunito", system-ui, sans-serif', maxWidth: '500px', margin: '0 auto', minHeight: '100vh', background: '#FFF8EC', color: '#2A2118', paddingBottom: '120px' },
    header: { background: '#2A2118', color: '#FFF8EC', padding: '20px 20px 16px', textAlign: 'center', position: 'relative' },
    headerTitle: { fontSize: '28px', fontWeight: '800', margin: 0, letterSpacing: '-0.5px' },
    headerSub: { fontSize: '16px', opacity: 0.85, marginTop: '4px' },
    householdBadge: { fontSize: '12px', opacity: 0.6, marginTop: '6px', cursor: 'pointer', textDecoration: 'underline' },
    syncDot: { position: 'absolute', top: '20px', right: '20px', width: '10px', height: '10px', borderRadius: '50%', background: syncing ? '#E67E22' : '#5BA85B', transition: 'background 0.3s' },
    tabBar: { position: 'fixed', bottom: 0, left: 0, right: 0, maxWidth: '500px', margin: '0 auto', background: '#FFFFFF', borderTop: '2px solid #E8DCC4', display: 'flex', padding: '8px', gap: '6px', boxShadow: '0 -4px 20px rgba(0,0,0,0.08)' },
    tab: (active) => ({ flex: 1, padding: '14px 8px', border: 'none', borderRadius: '14px', background: active ? '#2A2118' : 'transparent', color: active ? '#FFF8EC' : '#2A2118', fontSize: '16px', fontWeight: '700', cursor: 'pointer' }),
    dateBar: { padding: '20px', textAlign: 'center' },
    dateLabel: { fontSize: '22px', fontWeight: '700', marginBottom: '12px' },
    dateInput: { fontSize: '20px', padding: '12px 18px', border: '2px solid #2A2118', borderRadius: '12px', fontFamily: 'inherit', background: '#FFFFFF', color: '#2A2118', fontWeight: '600' },
    statusBanner: (state) => {
      const palette = { normal: { bg: '#D8E9D5', fg: '#2D5520' }, skip: { bg: '#FBE3D3', fg: '#7A3D1E' }, extra: { bg: '#D5E5F2', fg: '#1E4A7A' }, mixed: { bg: '#F2E6D5', fg: '#5B4423' } }[state];
      return { margin: '0 20px 16px', padding: '16px 20px', borderRadius: '16px', background: palette.bg, color: palette.fg, fontSize: '17px', fontWeight: '700', textAlign: 'center' };
    },
    milkCard: (color) => ({ background: '#FFFFFF', margin: '16px 20px', padding: '24px 20px', borderRadius: '24px', borderLeft: `8px solid ${color}`, boxShadow: '0 4px 16px rgba(0,0,0,0.06)' }),
    milkLabel: { fontSize: '24px', fontWeight: '800', marginBottom: '4px' },
    milkSub: { fontSize: '15px', color: '#6B5D4A', marginBottom: '16px' },
    counterRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
    counterBtn: (color) => ({ width: '64px', height: '64px', borderRadius: '50%', border: 'none', background: color, color: '#FFFFFF', fontSize: '32px', fontWeight: '800', cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }),
    counterValue: (positive, zero) => ({ fontSize: '32px', fontWeight: '800', textAlign: 'center', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, color: zero ? '#2D5520' : (positive ? '#1E4A7A' : '#7A3D1E') }),
    counterUnit: (zero) => ({ fontSize: '13px', fontWeight: '700', textAlign: 'center', color: zero ? '#2D5520' : '#6B5D4A', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }),
    actualLine: { fontSize: '14px', color: '#6B5D4A', textAlign: 'center', marginTop: '8px' },
    actionRow: { display: 'flex', gap: '10px', margin: '8px 20px 16px' },
    smallBtn: (variant) => ({ flex: 1, padding: '14px 12px', fontSize: '16px', fontWeight: '700', border: 'none', borderRadius: '12px', cursor: 'pointer', background: variant === 'danger' ? '#A63D2A' : '#E8DCC4', color: variant === 'danger' ? '#FFF8EC' : '#2A2118', fontFamily: 'inherit' }),
    summaryCard: { background: '#2A2118', color: '#FFF8EC', margin: '20px', padding: '24px', borderRadius: '24px', textAlign: 'center' },
    summaryRow: { display: 'flex', justifyContent: 'space-around', marginTop: '16px' },
    summaryItem: { flex: 1 },
    summaryLabel: { fontSize: '13px', opacity: 0.7, marginBottom: '4px' },
    summaryValue: { fontSize: '22px', fontWeight: '800' },
    bigNumber: { fontSize: '44px', fontWeight: '800', letterSpacing: '-1px' },
    sectionTitle: { fontSize: '20px', fontWeight: '800', padding: '20px 20px 8px' },
    historyItem: { background: '#FFFFFF', margin: '8px 20px', padding: '16px 20px', borderRadius: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' },
    rateCard: { background: '#FFFFFF', margin: '12px 20px', padding: '20px', borderRadius: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' },
    rateForm: { background: '#FFFFFF', margin: '12px 20px', padding: '20px', borderRadius: '16px', border: '2px dashed #C9A961' },
    input: { width: '100%', fontSize: '18px', padding: '14px 16px', border: '2px solid #E8DCC4', borderRadius: '12px', fontFamily: 'inherit', marginBottom: '12px', boxSizing: 'border-box', background: '#FFF8EC' },
    label: { fontSize: '16px', fontWeight: '700', marginBottom: '6px', display: 'block' },
    bigBtn: (variant) => ({ width: '100%', padding: '18px', fontSize: '20px', fontWeight: '800', border: 'none', borderRadius: '14px', cursor: 'pointer', background: variant === 'primary' ? '#2A2118' : '#E8DCC4', color: variant === 'primary' ? '#FFF8EC' : '#2A2118', marginTop: '8px', fontFamily: 'inherit' }),
    emptyState: { textAlign: 'center', padding: '40px 20px', color: '#6B5D4A', fontSize: '17px' },
    billCard: { background: '#FFFFFF', margin: '20px', padding: '24px', borderRadius: '24px', boxShadow: '0 4px 16px rgba(0,0,0,0.08)', borderLeft: '8px solid #2A2118' },
    billRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', fontSize: '17px' },
    deleteBtn: { background: 'transparent', border: 'none', color: '#A63D2A', fontSize: '15px', fontWeight: '700', cursor: 'pointer', padding: '8px 4px' },
    authCard: { background: '#FFFFFF', margin: '40px 20px', padding: '30px 24px', borderRadius: '24px', boxShadow: '0 4px 24px rgba(0,0,0,0.08)' },
    codeBox: { background: '#FFF8EC', padding: '12px 16px', borderRadius: '12px', fontFamily: 'monospace', fontSize: '13px', wordBreak: 'break-all', border: '1px dashed #C9A961' },
  };

  const BLUE = '#1E5B9E';
  const ORANGE = '#E67E22';

  let bannerState = 'normal';
  if (todayAdj.blue !== 0 || todayAdj.orange !== 0) {
    const hasSkip = todayAdj.blue < 0 || todayAdj.orange < 0;
    const hasExtra = todayAdj.blue > 0 || todayAdj.orange > 0;
    if (hasSkip && hasExtra) bannerState = 'mixed';
    else if (hasSkip) bannerState = 'skip';
    else bannerState = 'extra';
  }

  // ==========================================================================
  // RENDER GATES
  // ==========================================================================
  if (loadingAuth) {
    return <div style={{ ...styles.container, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ fontSize: '20px', fontWeight: '700' }}>Loading…</div>
    </div>;
  }

  // SIGN IN / SIGN UP
  if (!session) {
    return (
      <div style={styles.container}>
        <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet" />
        <div style={styles.header}>
          <h1 style={styles.headerTitle}>Milk Diary</h1>
          <div style={styles.headerSub}>Sign in to continue</div>
        </div>
        <div style={styles.authCard}>
          <label style={styles.label}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={styles.input} placeholder="your@email.com" />
          <label style={styles.label}>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} style={styles.input} placeholder="••••••••" />
          {authError && <div style={{ color: '#A63D2A', fontSize: '15px', marginBottom: '12px' }}>{authError}</div>}
          {authMode === 'signin' ? (
            <>
              <button style={styles.bigBtn('primary')} onClick={signIn}>Sign In</button>
              <button style={styles.bigBtn('secondary')} onClick={() => { setAuthMode('signup'); setAuthError(''); }}>Create New Account</button>
            </>
          ) : (
            <>
              <button style={styles.bigBtn('primary')} onClick={signUp}>Sign Up</button>
              <button style={styles.bigBtn('secondary')} onClick={() => { setAuthMode('signin'); setAuthError(''); }}>Back to Sign In</button>
            </>
          )}
        </div>
      </div>
    );
  }

  // NO HOUSEHOLD YET — create or join
  if (!household) {
    return (
      <div style={styles.container}>
        <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet" />
        <div style={styles.header}>
          <h1 style={styles.headerTitle}>Milk Diary</h1>
          <div style={styles.headerSub}>Welcome, {session.user.email}</div>
        </div>

        <div style={styles.sectionTitle}>Start a household</div>
        <div style={styles.rateForm}>
          <label style={styles.label}>Household name</label>
          <input value={householdName} onChange={e => setHouseholdName(e.target.value)} style={styles.input} placeholder="e.g. Mom's Home" />
          <button style={styles.bigBtn('primary')} onClick={createHousehold}>Create Household</button>
        </div>

        <div style={styles.sectionTitle}>Or join an existing one</div>
        <div style={styles.rateForm}>
          <label style={styles.label}>Household code (ask whoever created it)</label>
          <input value={joinCode} onChange={e => setJoinCode(e.target.value)} style={styles.input} placeholder="paste household ID here" />
          <button style={styles.bigBtn('primary')} onClick={joinHousehold}>Join</button>
        </div>

        <div style={{ padding: '20px' }}>
          <button style={styles.bigBtn('secondary')} onClick={signOut}>Sign Out</button>
        </div>
      </div>
    );
  }

  // MAIN APP
  return (
    <div style={styles.container}>
      <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet" />

      <div style={styles.header}>
        <div style={styles.syncDot} title={syncing ? 'Syncing…' : 'Live'}></div>
        <h1 style={styles.headerTitle}>Milk Diary</h1>
        <div style={styles.headerSub}>
          {view === 'today' && formatDate(selectedDate)}
          {view === 'bill' && 'Monthly Bill'}
          {view === 'history' && 'Changes Log'}
          {view === 'rates' && 'Rates & Settings'}
        </div>
        <div style={styles.householdBadge} onClick={() => setShowHouseholdMenu(!showHouseholdMenu)}>
          {household.name} · {members.length} member{members.length !== 1 ? 's' : ''}
        </div>
        <div style={{ fontSize: '10px', opacity: 0.4, marginTop: '4px' }}>v0.4 — advance payment model</div>
      </div>

      {showHouseholdMenu && (
        <div style={styles.rateForm}>
          <div style={{ fontSize: '15px', fontWeight: '700', marginBottom: '8px' }}>Invite a family member</div>
          <div style={{ fontSize: '13px', color: '#6B5D4A', marginBottom: '8px' }}>
            Share this household code. They'll need to sign up first, then paste this:
          </div>
          <div style={styles.codeBox}>{household.id}</div>
          <button style={styles.bigBtn('secondary')} onClick={() => navigator.clipboard.writeText(household.id)}>
            Copy Code
          </button>
          <button style={styles.bigBtn('secondary')} onClick={signOut}>Sign Out</button>
        </div>
      )}

      {view === 'today' && (
        <>
          <div style={styles.dateBar}>
            <div style={styles.dateLabel}>Choose Date</div>
            <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} style={styles.dateInput} />
          </div>

          {!currentRate && (
            <div style={{ ...styles.emptyState, background: '#FFF3CD', margin: '0 20px 16px', borderRadius: '16px', padding: '16px' }}>
              ⚠️ Set milk rates first.<br />Tap "Rates" tab below.
            </div>
          )}

          <div style={styles.statusBanner(bannerState)}>{buildStatusText()}</div>

          <div style={styles.milkCard(BLUE)}>
            <div style={styles.milkLabel}>Blue Packet</div>
            <div style={styles.milkSub}>
              Default: {defaults.blue}L · {currentRate ? `₹${currentRate.bluePerHalf}/½L` : 'rate not set'}
            </div>
            <div style={styles.counterRow}>
              <button style={styles.counterBtn(BLUE)} onClick={() => updateAdj('blue', -0.5)}>−</button>
              <div style={{ flex: 1 }}>
                <div style={styles.counterValue(todayAdj.blue > 0, todayAdj.blue === 0)}>
                  {todayAdj.blue === 0 ? '0' : (todayAdj.blue > 0 ? `+${todayAdj.blue.toFixed(1)}` : todayAdj.blue.toFixed(1))}L
                </div>
                <div style={styles.counterUnit(todayAdj.blue === 0)}>
                  {todayAdj.blue === 0 ? 'as usual' : (todayAdj.blue > 0 ? 'extra taken' : 'skipped')}
                </div>
                <div style={styles.actualLine}>
                  → got {Math.max(0, defaults.blue + todayAdj.blue).toFixed(1)}L today
                </div>
              </div>
              <button style={styles.counterBtn(BLUE)} onClick={() => updateAdj('blue', 0.5)}>+</button>
            </div>
          </div>

          <div style={styles.milkCard(ORANGE)}>
            <div style={styles.milkLabel}>Orange Packet</div>
            <div style={styles.milkSub}>
              Default: {defaults.orange}L · {currentRate ? `₹${currentRate.orangePerHalf}/½L` : 'rate not set'}
            </div>
            <div style={styles.counterRow}>
              <button style={styles.counterBtn(ORANGE)} onClick={() => updateAdj('orange', -0.5)}>−</button>
              <div style={{ flex: 1 }}>
                <div style={styles.counterValue(todayAdj.orange > 0, todayAdj.orange === 0)}>
                  {todayAdj.orange === 0 ? '0' : (todayAdj.orange > 0 ? `+${todayAdj.orange.toFixed(1)}` : todayAdj.orange.toFixed(1))}L
                </div>
                <div style={styles.counterUnit(todayAdj.orange === 0)}>
                  {todayAdj.orange === 0 ? 'as usual' : (todayAdj.orange > 0 ? 'extra taken' : 'skipped')}
                </div>
                <div style={styles.actualLine}>
                  → got {Math.max(0, defaults.orange + todayAdj.orange).toFixed(1)}L today
                </div>
              </div>
              <button style={styles.counterBtn(ORANGE)} onClick={() => updateAdj('orange', 0.5)}>+</button>
            </div>
          </div>

          <div style={styles.actionRow}>
            <button style={styles.smallBtn('secondary')} onClick={markFullSkip}>Skip whole day</button>
            <button style={styles.smallBtn('danger')} onClick={clearAdj}>Reset to normal</button>
          </div>
        </>
      )}

      {view === 'bill' && (() => {
        // Net L this month: positive = extra net, negative = skipped net
        const blueNet = currentMonth.blueExtra - currentMonth.blueSkipped;
        const orangeNet = currentMonth.orangeExtra - currentMonth.orangeSkipped;

        // Next month (the one she's about to pay for, in advance)
        const nextMonthDate = (() => {
          const [yr, mo] = currentMonthPrefix.split('-').map(Number);
          const nextMo = mo === 12 ? 1 : mo + 1;
          const nextYr = mo === 12 ? yr + 1 : yr;
          return `${nextYr}-${String(nextMo).padStart(2, '0')}`;
        })();
        const [nYr, nMo] = nextMonthDate.split('-').map(Number);
        const nextMonthDays = daysInMonth(nYr, nMo);
        const projectionRate = getRateForDate(`${nextMonthDate}-01`) || currentRate;
        const projectedBlueL = defaults.blue * nextMonthDays;
        const projectedOrangeL = defaults.orange * nextMonthDays;
        const projectedCost = projectionRate
          ? (projectedBlueL * 2 * projectionRate.bluePerHalf) + (projectedOrangeL * 2 * projectionRate.orangePerHalf)
          : 0;

        // The adjustment to subtract = THIS MONTH's net (skips minus extras)
        // (because she pays next month in advance and deducts this month's balance)
        const thisMonthDeduction = currentMonth.skippedCost - currentMonth.extraCost;
        // positive = she saved money (more skips) → subtract
        // negative = she owes more (more extras) → add

        const nextMonthBill = projectedCost - thisMonthDeduction;

        const monthLabel = new Date(selectedDate).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
        const nextMonthLabel = new Date(nextMonthDate + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

        return (
          <>
            {/* This month so far — quantities */}
            <div style={styles.sectionTitle}>{monthLabel} so far</div>

            <div style={styles.summaryCard}>
              <div style={{ fontSize: '15px', opacity: 0.7, marginBottom: '8px' }}>Blue Packet</div>
              <div style={styles.summaryRow}>
                <div style={styles.summaryItem}>
                  <div style={styles.summaryLabel}>Not taken</div>
                  <div style={{ ...styles.summaryValue, color: '#FBE3D3' }}>{currentMonth.blueSkipped.toFixed(1)}L</div>
                </div>
                <div style={styles.summaryItem}>
                  <div style={styles.summaryLabel}>Extra taken</div>
                  <div style={{ ...styles.summaryValue, color: '#D5E5F2' }}>{currentMonth.blueExtra.toFixed(1)}L</div>
                </div>
                <div style={styles.summaryItem}>
                  <div style={styles.summaryLabel}>Net</div>
                  <div style={{ ...styles.summaryValue, color: blueNet === 0 ? '#FFF8EC' : (blueNet > 0 ? '#A8D5F0' : '#F5C9B2') }}>
                    {blueNet > 0 ? '+' : ''}{blueNet.toFixed(1)}L
                  </div>
                </div>
              </div>
            </div>

            <div style={styles.summaryCard}>
              <div style={{ fontSize: '15px', opacity: 0.7, marginBottom: '8px' }}>Orange Packet</div>
              <div style={styles.summaryRow}>
                <div style={styles.summaryItem}>
                  <div style={styles.summaryLabel}>Not taken</div>
                  <div style={{ ...styles.summaryValue, color: '#FBE3D3' }}>{currentMonth.orangeSkipped.toFixed(1)}L</div>
                </div>
                <div style={styles.summaryItem}>
                  <div style={styles.summaryLabel}>Extra taken</div>
                  <div style={{ ...styles.summaryValue, color: '#D5E5F2' }}>{currentMonth.orangeExtra.toFixed(1)}L</div>
                </div>
                <div style={styles.summaryItem}>
                  <div style={styles.summaryLabel}>Net</div>
                  <div style={{ ...styles.summaryValue, color: orangeNet === 0 ? '#FFF8EC' : (orangeNet > 0 ? '#A8D5F0' : '#F5C9B2') }}>
                    {orangeNet > 0 ? '+' : ''}{orangeNet.toFixed(1)}L
                  </div>
                </div>
              </div>
            </div>

            {/* Net effect in ₹ */}
            <div style={{ ...styles.summaryCard, background: thisMonthDeduction >= 0 ? '#7A3D1E' : '#1E4A7A' }}>
              <div style={{ fontSize: '15px', opacity: 0.85 }}>{monthLabel} net effect</div>
              <div style={styles.bigNumber}>
                {thisMonthDeduction >= 0 ? '−' : '+'} ₹{Math.abs(thisMonthDeduction).toFixed(0)}
              </div>
              <div style={{ fontSize: '13px', opacity: 0.8, marginTop: '4px' }}>
                {thisMonthDeduction > 0 && `subtract from ${nextMonthLabel.split(' ')[0]} payment`}
                {thisMonthDeduction < 0 && `add to ${nextMonthLabel.split(' ')[0]} payment`}
                {thisMonthDeduction === 0 && 'no adjustment'}
              </div>
            </div>

            {/* What to pay at start of next month */}
            <div style={styles.sectionTitle}>To pay on 1st {nextMonthLabel}</div>

            <div style={styles.billCard}>
              <div style={{ fontSize: '15px', color: '#6B5D4A', marginBottom: '12px', textAlign: 'center' }}>
                Full {nextMonthLabel.split(' ')[0]} delivery ({nextMonthDays} days)
              </div>
              <div style={styles.billRow}>
                <span><span style={{ color: BLUE, fontWeight: 700 }}>Blue:</span> {defaults.blue}L × {nextMonthDays} days</span>
                <span style={{ fontWeight: 700 }}>{projectedBlueL.toFixed(1)}L</span>
              </div>
              <div style={styles.billRow}>
                <span><span style={{ color: ORANGE, fontWeight: 700 }}>Orange:</span> {defaults.orange}L × {nextMonthDays} days</span>
                <span style={{ fontWeight: 700 }}>{projectedOrangeL.toFixed(1)}L</span>
              </div>

              {!projectionRate && (
                <div style={{ ...styles.emptyState, padding: '16px 0' }}>
                  Set a rate to see cost
                </div>
              )}

              {projectionRate && (
                <>
                  <div style={{ borderTop: '1px solid #E8DCC4', marginTop: '12px', paddingTop: '12px' }}>
                    <div style={styles.billRow}>
                      <span>Full month cost</span>
                      <span style={{ fontWeight: 700 }}>₹{projectedCost.toFixed(0)}</span>
                    </div>
                    <div style={styles.billRow}>
                      <span>Subtract {monthLabel.split(' ')[0]} balance</span>
                      <span style={{ fontWeight: 700, color: thisMonthDeduction >= 0 ? '#A63D2A' : '#1E4A7A' }}>
                        {thisMonthDeduction >= 0 ? '−' : '+'} ₹{Math.abs(thisMonthDeduction).toFixed(0)}
                      </span>
                    </div>
                  </div>
                  <div style={{ borderTop: '2px solid #2A2118', marginTop: '4px', paddingTop: '16px', textAlign: 'center' }}>
                    <div style={{ fontSize: '17px', color: '#6B5D4A' }}>Pay milkman</div>
                    <div style={{ fontSize: '52px', fontWeight: '800', letterSpacing: '-1px' }}>₹{nextMonthBill.toFixed(0)}</div>
                  </div>
                </>
              )}
            </div>

            {/* This month's breakdown — what's being subtracted */}
            <div style={styles.sectionTitle}>{monthLabel} details</div>
            <div style={styles.rateCard}>
              <div style={styles.billRow}>
                <span><span style={{ color: BLUE, fontWeight: 700 }}>Blue</span> not taken</span>
                <span style={{ fontWeight: 700 }}>{currentMonth.blueSkipped.toFixed(1)}L</span>
              </div>
              <div style={styles.billRow}>
                <span><span style={{ color: BLUE, fontWeight: 700 }}>Blue</span> extra taken</span>
                <span style={{ fontWeight: 700 }}>{currentMonth.blueExtra.toFixed(1)}L</span>
              </div>
              <div style={styles.billRow}>
                <span><span style={{ color: ORANGE, fontWeight: 700 }}>Orange</span> not taken</span>
                <span style={{ fontWeight: 700 }}>{currentMonth.orangeSkipped.toFixed(1)}L</span>
              </div>
              <div style={styles.billRow}>
                <span><span style={{ color: ORANGE, fontWeight: 700 }}>Orange</span> extra taken</span>
                <span style={{ fontWeight: 700 }}>{currentMonth.orangeExtra.toFixed(1)}L</span>
              </div>
              <div style={{ borderTop: '1px solid #E8DCC4', marginTop: '8px', paddingTop: '12px' }}>
                <div style={styles.billRow}>
                  <span>Value of skips</span>
                  <span style={{ fontWeight: 700, color: '#A63D2A' }}>− ₹{currentMonth.skippedCost.toFixed(0)}</span>
                </div>
                <div style={styles.billRow}>
                  <span>Value of extras</span>
                  <span style={{ fontWeight: 700, color: '#1E4A7A' }}>+ ₹{currentMonth.extraCost.toFixed(0)}</span>
                </div>
                <div style={{ ...styles.billRow, fontWeight: 800, borderTop: '2px solid #2A2118', marginTop: '4px', paddingTop: '8px' }}>
                  <span>Net to subtract</span>
                  <span style={{ color: thisMonthDeduction >= 0 ? '#A63D2A' : '#1E4A7A' }}>
                    {thisMonthDeduction >= 0 ? '−' : '+'} ₹{Math.abs(thisMonthDeduction).toFixed(0)}
                  </span>
                </div>
              </div>
            </div>
          </>
        );
      })()}

      {view === 'history' && (
        <>
          <div style={styles.sectionTitle}>All Changes</div>
          <div style={{ padding: '0 20px 8px', fontSize: '14px', color: '#6B5D4A' }}>Days she skipped or took extra</div>
          {adjDays.length === 0 ? (
            <div style={styles.emptyState}>No changes yet — all normal days.</div>
          ) : adjDays.map(([date, a]) => {
            const rate = getRateForDate(date);
            let netCost = rate ? (a.blue * 2 * rate.bluePerHalf) + (a.orange * 2 * rate.orangePerHalf) : 0;
            return (
              <div key={date} style={styles.historyItem}>
                <div>
                  <div style={{ fontSize: '18px', fontWeight: '700' }}>{formatDateShort(date)}</div>
                  <div style={{ fontSize: '15px', color: '#6B5D4A', marginTop: '4px' }}>
                    {a.blue !== 0 && <span style={{ color: BLUE, fontWeight: 700 }}>Blue {a.blue > 0 ? '+' : ''}{a.blue}L</span>}
                    {a.blue !== 0 && a.orange !== 0 && ' · '}
                    {a.orange !== 0 && <span style={{ color: ORANGE, fontWeight: 700 }}>Orange {a.orange > 0 ? '+' : ''}{a.orange}L</span>}
                  </div>
                </div>
                <div style={{ fontSize: '20px', fontWeight: '800', color: netCost > 0 ? '#1E4A7A' : '#A63D2A' }}>
                  {netCost > 0 ? '+' : ''}₹{netCost.toFixed(0)}
                </div>
              </div>
            );
          })}
        </>
      )}

      {view === 'rates' && (
        <>
          <div style={styles.sectionTitle}>Daily Delivery</div>
          {!showDefaultsForm ? (
            <div style={styles.rateCard}>
              <div style={{ fontSize: '16px', marginBottom: '8px' }}>
                <span style={{ color: BLUE, fontWeight: 700 }}>Blue:</span> {defaults.blue}L per day
              </div>
              <div style={{ fontSize: '16px', marginBottom: '12px' }}>
                <span style={{ color: ORANGE, fontWeight: 700 }}>Orange:</span> {defaults.orange}L per day
              </div>
              <button style={styles.bigBtn('secondary')} onClick={() => {
                setTempDefaults({ blue: defaults.blue.toString(), orange: defaults.orange.toString() });
                setShowDefaultsForm(true);
              }}>Change daily quantity</button>
            </div>
          ) : (
            <div style={styles.rateForm}>
              <label style={styles.label}>Blue litres per day</label>
              <input type="number" inputMode="decimal" step="0.5" value={tempDefaults.blue}
                onChange={(e) => setTempDefaults({ ...tempDefaults, blue: e.target.value })} style={styles.input} />
              <label style={styles.label}>Orange litres per day</label>
              <input type="number" inputMode="decimal" step="0.5" value={tempDefaults.orange}
                onChange={(e) => setTempDefaults({ ...tempDefaults, orange: e.target.value })} style={styles.input} />
              <button style={styles.bigBtn('primary')} onClick={saveDefaults}>Save</button>
              <button style={styles.bigBtn('secondary')} onClick={() => setShowDefaultsForm(false)}>Cancel</button>
            </div>
          )}

          <div style={styles.sectionTitle}>Milk Rates</div>
          <div style={{ padding: '0 20px 12px', fontSize: '15px', color: '#6B5D4A', lineHeight: 1.5 }}>
            Add a new rate when prices change. Old days keep their old price.
          </div>

          {!showRateForm && (
            <div style={{ padding: '0 20px' }}>
              <button style={styles.bigBtn('primary')} onClick={() => {
                setNewRate({ startDate: new Date().toISOString().split('T')[0], bluePerHalf: '', orangePerHalf: '' });
                setShowRateForm(true);
              }}>+ Add New Rate</button>
            </div>
          )}

          {showRateForm && (
            <div style={styles.rateForm}>
              <label style={styles.label}>Start Date</label>
              <input type="date" value={newRate.startDate}
                onChange={(e) => setNewRate({ ...newRate, startDate: e.target.value })} style={styles.input} />
              <label style={styles.label}>Blue — ½ litre price (₹)</label>
              <input type="number" inputMode="decimal" placeholder="e.g. 30" value={newRate.bluePerHalf}
                onChange={(e) => setNewRate({ ...newRate, bluePerHalf: e.target.value })} style={styles.input} />
              <label style={styles.label}>Orange — ½ litre price (₹)</label>
              <input type="number" inputMode="decimal" placeholder="e.g. 35" value={newRate.orangePerHalf}
                onChange={(e) => setNewRate({ ...newRate, orangePerHalf: e.target.value })} style={styles.input} />
              <button style={styles.bigBtn('primary')} onClick={addRate}>Save Rate</button>
              <button style={styles.bigBtn('secondary')} onClick={() => setShowRateForm(false)}>Cancel</button>
            </div>
          )}

          {rates.length === 0 ? (
            <div style={styles.emptyState}>No rates yet. Tap the button above.</div>
          ) : [...rates].sort((a, b) => b.startDate.localeCompare(a.startDate)).map(r => (
            <div key={r.startDate} style={styles.rateCard}>
              <div style={{ fontSize: '17px', fontWeight: '700', marginBottom: '10px' }}>From {formatDate(r.startDate)}</div>
              <div style={{ fontSize: '16px', marginBottom: '6px' }}>
                <span style={{ color: BLUE, fontWeight: 700 }}>Blue:</span> ₹{r.bluePerHalf}/½L (₹{r.bluePerHalf * 2}/L)
              </div>
              <div style={{ fontSize: '16px' }}>
                <span style={{ color: ORANGE, fontWeight: 700 }}>Orange:</span> ₹{r.orangePerHalf}/½L (₹{r.orangePerHalf * 2}/L)
              </div>
              <button style={styles.deleteBtn} onClick={() => deleteRate(r.startDate)}>Remove</button>
            </div>
          ))}
        </>
      )}

      <div style={styles.tabBar}>
        <button style={styles.tab(view === 'today')} onClick={() => setView('today')}>Today</button>
        <button style={styles.tab(view === 'bill')} onClick={() => setView('bill')}>Bill</button>
        <button style={styles.tab(view === 'history')} onClick={() => setView('history')}>Log</button>
        <button style={styles.tab(view === 'rates')} onClick={() => setView('rates')}>Rates</button>
      </div>
    </div>
  );
}
