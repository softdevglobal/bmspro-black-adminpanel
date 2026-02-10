"use client";

interface OwnerAccountInactiveModalProps {
  isOpen: boolean;
  reason: string;
  ownerName?: string;
  onLogout: () => void;
}

export default function OwnerAccountInactiveModal({
  isOpen,
  reason,
  ownerName,
  onLogout,
}: OwnerAccountInactiveModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
        {/* Header with warning gradient */}
        <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-8 text-center">
          <div className="w-20 h-20 mx-auto bg-white/20 rounded-full flex items-center justify-center mb-4">
            <i className="fas fa-exclamation-triangle text-white text-4xl" />
          </div>
          <h2 className="text-2xl font-bold text-white">
            Workshop Account Inactive
          </h2>
        </div>

        {/* Content */}
        <div className="px-6 py-6">
          {/* Reason message */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
            <p className="text-amber-800 text-center font-medium">
              {reason}
            </p>
          </div>

          {/* Owner info */}
          {ownerName && (
            <div className="flex items-center gap-3 bg-neutral-50 rounded-xl p-4 mb-6">
              <div className="w-10 h-10 bg-neutral-100 rounded-full flex items-center justify-center">
                <i className="fas fa-user-tie text-neutral-600" />
              </div>
              <div>
                <p className="text-xs text-neutral-500">Workshop Owner</p>
                <p className="text-sm font-semibold text-neutral-700">{ownerName}</p>
              </div>
            </div>
          )}

          {/* Instructions */}
          <div className="text-center mb-6">
            <p className="text-neutral-600 text-sm leading-relaxed">
              Please contact the workshop owner to resolve this issue. 
              The workshop owner needs to update their subscription or payment details 
              to restore access.
            </p>
          </div>

          {/* Info box */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
            <p className="text-blue-700 text-sm text-center">
              <span className="font-semibold">Note:</span> Only the workshop owner can manage 
              subscriptions and payments through the web portal.
            </p>
          </div>

          {/* Logout button */}
          <button
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 bg-neutral-900 hover:bg-neutral-800 text-white font-semibold py-3 px-6 rounded-xl transition-all duration-200 shadow-lg hover:shadow-xl"
          >
            <i className="fas fa-sign-out-alt mr-2" />
            Logout
          </button>
        </div>

        {/* Footer */}
        <div className="bg-neutral-50 px-6 py-4 text-center border-t border-neutral-100">
          <p className="text-xs text-neutral-500">
            Need help? Contact support at{" "}
            <a href="mailto:support@bmspro.com.au" className="text-neutral-700 font-medium hover:underline">
              support@bmspro.com.au
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
