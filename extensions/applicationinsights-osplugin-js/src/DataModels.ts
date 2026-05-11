/**
* DataModels.ts
* @author Siyu Niu (siyuniu)
* @copyright Microsoft 2024
* File containing the interfaces for OS Plugin SDK.
*/

/**
 * Interface for OS Plugin SDK config
 * \@maxTimeout: Maximum time to wait for the OS plugin to return the OS information
 */
export interface IOSPluginConfiguration {
    /**
     * Maximum time to wait for the OS plugin to return the OS information
     * Default: 200
     */
    maxTimeout?: number;
    /**
     * @deprecated This option is deprecated and will be removed in a future version.
     * When true, merges os name and version into ext.os.osVer (e.g. "Windows11").
     * When false or undefined, uses the correct field names based on the detected channel:
     * - CS 4.0 (1DS PostChannel): ext.os.name + ext.os.ver
     * - CS 2.x (AI Sender): ext.os.os + ext.os.osVer
     */
    mergeOsNameVersion?: boolean;
}
