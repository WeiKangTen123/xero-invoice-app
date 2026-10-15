import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import ChangePasswordCard from './account/ChangePasswordCard';
import SessionsCard from './account/SessionsCard';
import SignInsCard from './account/SignInsCard';
import { setPasswordMode } from './account/account';

// What belongs to the person rather than the app: their password, the
// devices signed in as them, and where this account has signed in from. Setup
// is the app's settings; this is theirs.
//
// Set-password mode (?set-password=1, or the user's own mustChangePassword):
// an administrator gave them a temporary password, the server refuses every
// other request until it is replaced, and the route guard (App.jsx) sends
// every other page here. The password card is headed for that, and the one
// control that would be refused (Sign out everywhere) is left out until the
// password is set. Recent sign-ins stays: it is allowed, and "was that
// really my administrator?" is the question of the moment.
export default function Account() {
  const { user, refreshUser } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const settingPassword = setPasswordMode(location.search, user);

  // The user is read again so mustChangePassword is false everywhere before
  // the dashboard mounts; otherwise the guard would send them straight back.
  async function onPasswordSet() {
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
            : 'Your password, the devices signed in as you, and where this account has signed in from.'}
        </p>
      </div>

      <ChangePasswordCard idx={0} setPassword={settingPassword} onPasswordSet={settingPassword ? onPasswordSet : undefined} />
      {!settingPassword && <SessionsCard idx={1} />}
      <SignInsCard idx={settingPassword ? 1 : 2} />
    </div>
  );
}
