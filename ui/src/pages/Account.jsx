import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import ChangePasswordCard from './account/ChangePasswordCard';
import SessionsCard from './account/SessionsCard';
import SignInsCard from './account/SignInsCard';
import TwoStepCard from './account/TwoStepCard';
import { setPasswordMode } from './account/account';
import { twoStepSetupMode, SETUP_REQUIRED_TITLE, SETUP_REQUIRED_INTRO } from './account/two-step';

// What belongs to the person rather than the app: their password, their
// 2-step sign-in, the devices signed in as them, and where this account has
// signed in from. Setup is the app's settings; this is theirs.
//
// Set-password mode (?set-password=1, or the user's own mustChangePassword):
// an administrator gave them a temporary password, or their own one no longer
// meets the rules (user.passwordChangeReason), the server refuses every
// other request until it is replaced, and the route guard (App.jsx) sends
// every other page here. The password card is headed for that, and the one
// control that would be refused (Sign out everywhere) is left out until the
// password is set. Recent sign-ins stays: it is allowed, and "was that
// really my administrator?" is the question of the moment.
//
// Set-up-2-step mode (?setup-2-step=1, or the user's own mfaSetupRequired):
// an admin without 2-step sign-in, whom the server refuses everything else
// (403 mfa_setup_required) until it is on. Only the 2-step card is shown,
// headed for it; the others would be refused. A password to set comes
// first, as on the server: the 2-step card waits until it is set.
export default function Account() {
  const { user, refreshUser } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const settingPassword = setPasswordMode(location.search, user);
  const settingUp2Step  = !settingPassword && twoStepSetupMode(location.search, user);

  // The user is read again so mustChangePassword is false everywhere before
  // the dashboard mounts; otherwise the guard would send them straight back.
  async function onPasswordSet() {
    await refreshUser();
    navigate('/dashboard', { replace: true });
  }

  // The same once 2-step sign-in is on and the recovery codes are saved, so
  // mfaSetupRequired is false before the guard reads it.
  async function onTwoStepOn() {
    await refreshUser();
    navigate('/dashboard', { replace: true });
  }

  return (
    <div>
      <div className="page-header">
        <h1>Account</h1>
        <p>
          {settingPassword
            ? 'Set a password of your own to go on.'
            : settingUp2Step
              ? <><strong>{SETUP_REQUIRED_TITLE}.</strong> {SETUP_REQUIRED_INTRO}</>
              : 'Your password, 2-step sign-in, the devices signed in as you, and where this account has signed in from.'}
        </p>
      </div>

      {!settingUp2Step && <ChangePasswordCard idx={0} setPassword={settingPassword} onPasswordSet={settingPassword ? onPasswordSet : undefined} />}
      {!settingPassword && <TwoStepCard idx={settingUp2Step ? 0 : 1} setupRequired={settingUp2Step} onSetUp={settingUp2Step ? onTwoStepOn : undefined} />}
      {!settingPassword && !settingUp2Step && <SessionsCard idx={2} />}
      {!settingUp2Step && <SignInsCard idx={settingPassword ? 1 : 3} />}
    </div>
  );
}
