// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract Groth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 2758081547631361973675098252329745842547594613148824941016259946234232945191;
    uint256 constant deltax2 = 18443162976721141351500203960218021775565003357244833740492640976815110853486;
    uint256 constant deltay1 = 18999630326125984393591591348418764274155651852818419351753328135981493301564;
    uint256 constant deltay2 = 6464834834293024399390398101343107691715443822030738555038772402247994495128;

    
    uint256 constant IC0x = 4446606300787334488519396228737019620924871555016964435860305456011587704968;
    uint256 constant IC0y = 4370924993566242555488958348491759010157852584483914428846908247848304643938;
    
    uint256 constant IC1x = 15541704899260999672083065125408359478925469537660039743666884516484920888648;
    uint256 constant IC1y = 9039739940022096333666059268094021482938416081756338417171036655408782968830;
    
    uint256 constant IC2x = 2692700652235513034463097916172498282142394549183479236899844914112501099101;
    uint256 constant IC2y = 21693571245072074808094364999807141254913578850176518858832072826375953757450;
    
    uint256 constant IC3x = 7638104079593071973082082312357118496715466534567521059505352010998555604476;
    uint256 constant IC3y = 4223345032651315554054570068193467183019352569324404311928200658748606087012;
    
    uint256 constant IC4x = 11901340435173486725938225033331984374881955179949413814339180609074966666474;
    uint256 constant IC4y = 21751300224150818031614612955838559181646177415245022561621466172605114178118;
    
    uint256 constant IC5x = 386066403037337280782126511599050327241049996360983877620652785075577690500;
    uint256 constant IC5y = 2319886129724904913833409025068641748451093026652154889587421480971705674116;
    
    uint256 constant IC6x = 1905300516179335441032318408759856949272417862168131652325590369050965210357;
    uint256 constant IC6y = 3199996538676428043121992212556140679918025421488894734970321770424475147477;
    
    uint256 constant IC7x = 8575944862719366283831790127298508106397128510863093496384498890360157044216;
    uint256 constant IC7y = 19357669769161049769599588400615852338760375393409316126054822170702764886926;
    
    uint256 constant IC8x = 21774219382131196156041725054200742222918653901514284733446628578277087825203;
    uint256 constant IC8y = 12766944877756789400944414249847021208746951016715749145198995661241823820464;
    
    uint256 constant IC9x = 16587094547698476569738616728871325310797605844068279173457657795096133432911;
    uint256 constant IC9y = 2973884615429955554358347556802035899393812508461972143624910735557400716977;
    
    uint256 constant IC10x = 16851403747373297629944873164996669763609606165235256144028356477209715152705;
    uint256 constant IC10y = 876498572311443871395878608742679567215386056504398244555290175054299307761;
    
    uint256 constant IC11x = 12832702652917021174347851829873534903653485145658558791584532167652811420705;
    uint256 constant IC11y = 20775113366571447796627814999587648424680369785886015760043410687812957528382;
    
    uint256 constant IC12x = 17632549215414227808886723895231010726256819625070485057800757868139814668413;
    uint256 constant IC12y = 8249421303485782755040905525189397669436060271021289330955238205222015342227;
    
    uint256 constant IC13x = 20812321972537558500656201880689054707949886415368886567816282984617634487171;
    uint256 constant IC13y = 8322531519587291230294378446478992590902523618766033099479634602695587140397;
    
    uint256 constant IC14x = 15974850053874243530123896833939520754936930188609212759617423179166274480463;
    uint256 constant IC14y = 4243734696989356348138776194160692161685092538880300939503458694993670602569;
    
    uint256 constant IC15x = 5310792984886772293134756930411342765675242746789445821821605656302294737112;
    uint256 constant IC15y = 19203508535906217750823983164066855272773854951264981976108180073241103697499;
    
    uint256 constant IC16x = 9134943696727844606252901094768555955235144147118873408776718912337796808686;
    uint256 constant IC16y = 10300893686943549693938443210547883783176523987783244496805415324036497090156;
    
    uint256 constant IC17x = 2421655661702527741775918798224291859785493602398040969352191854430265941908;
    uint256 constant IC17y = 4351363709324668350037798663415955064403114689965547691890579648629472549166;
    
    uint256 constant IC18x = 7634716334469708563414177717241250126016079423592238317289251820134799292981;
    uint256 constant IC18y = 1239724851246901948460029956344029333006356414631121034528883027338166324845;
    
    uint256 constant IC19x = 12504104316120207584943369021851391416735745027954030806845488399393852814957;
    uint256 constant IC19y = 20151361304539561411191831126070772781785198806800564760953917893614343000936;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[19] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
